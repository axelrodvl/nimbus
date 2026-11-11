//! Обёртка над librqbit — единственное место, которое знает про торрент-движок.

#[cfg(feature = "test-fakes")]
pub mod fake_swarm;

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ListenerOptions, Magnet, ManagedTorrent,
    Session, SessionOptions, SessionPersistenceConfig,
};
use nimbus_core::model::InfoHash;
use tokio::io::{AsyncRead, AsyncSeek};
use tokio::sync::{Mutex, Semaphore};
use tracing::Instrument;

type ManagedTorrentHandle = Arc<ManagedTorrent>;

/// Одновременных `fetch_metadata` (каждый открывает DHT-поиск и соединения).
const METADATA_CONCURRENCY: usize = 4;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// `{NIMBUS_DATA_DIR}/torrents` — скачанные файлы.
    pub data_dir: PathBuf,
    /// `{NIMBUS_DATA_DIR}/session` — persistence librqbit.
    pub session_dir: PathBuf,
    /// Порт входящих соединений; `None` — диапазон 6881..6891.
    pub listen_port: Option<u16>,
    /// `false` — после завершения выбранных файлов торрент ставится на паузу (не раздаём).
    pub seeding: bool,
    pub metadata_timeout: Duration,
    /// Включить DHT.
    pub dht: bool,
    /// Слушать только 127.0.0.1 (тесты, локальный рой).
    pub localhost_only: bool,
    /// Включить сохранение сессии в `session_dir`.
    pub persistence: bool,
    /// Пиры, которые добавляются к каждому торренту (для тестов и закрытых сетей).
    pub initial_peers: Vec<SocketAddr>,
}

impl EngineConfig {
    /// Боевая конфигурация из каталога данных: `{base}/torrents`, `{base}/session`.
    pub fn new(base_dir: impl Into<PathBuf>, seeding: bool) -> Self {
        let base = base_dir.into();
        Self {
            data_dir: base.join("torrents"),
            session_dir: base.join("session"),
            listen_port: None,
            seeding,
            metadata_timeout: Duration::from_secs(90),
            dht: true,
            localhost_only: false,
            persistence: true,
            initial_peers: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub index: usize,
    /// Путь внутри торрента через `/` (как в `info.files[].path`, без имени корневой папки
    /// торрента; для однофайловых — имя файла).
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorrentMeta {
    pub info_hash: InfoHash,
    pub name: String,
    pub files: Vec<FileEntry>,
    pub piece_length: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileProgress {
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub peers: u32,
    pub down_speed_bps: u64,
    pub finished: bool,
}

/// Идентификатор торрента — info-hash (стабилен между перезапусками).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TorrentHandleId(pub InfoHash);

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("metadata was not received in time")]
    MetadataTimeout,
    #[error("invalid magnet: {0}")]
    InvalidMagnet(String),
    #[error("torrent or file not found in session")]
    NotFound,
    #[error("file index {0} is out of range")]
    InvalidFileIndex(usize),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

fn internal(e: impl std::fmt::Display) -> EngineError {
    EngineError::Internal(format!("{e:#}"))
}

/// Источник списка файлов по magnet (реализуется движком и фейком в тестах обработчиков).
#[async_trait::async_trait]
pub trait MetadataFetcher: Send + Sync {
    async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError>;
}

#[async_trait::async_trait]
impl MetadataFetcher for TorrentEngine {
    async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError> {
        TorrentEngine::fetch_metadata(self, magnet).await
    }
}

/// Доступ к файлам торрентов для стриминга (реализуется движком и фейком в тестах API).
#[async_trait::async_trait]
pub trait FileProvider: Send + Sync {
    async fn ensure_file(
        &self,
        magnet: &str,
        file_index: usize,
    ) -> Result<TorrentHandleId, EngineError>;
    async fn open_stream(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError>;
    fn file_progress(&self, id: &TorrentHandleId, file_index: usize) -> Option<FileProgress>;
    fn file_path(&self, id: &TorrentHandleId, file_index: usize) -> Option<PathBuf>;
}

#[async_trait::async_trait]
impl FileProvider for TorrentEngine {
    async fn ensure_file(
        &self,
        magnet: &str,
        file_index: usize,
    ) -> Result<TorrentHandleId, EngineError> {
        TorrentEngine::ensure_file(self, magnet, file_index).await
    }
    async fn open_stream(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        TorrentEngine::open_stream(self, id, file_index).await
    }
    fn file_progress(&self, id: &TorrentHandleId, file_index: usize) -> Option<FileProgress> {
        TorrentEngine::file_progress(self, id, file_index)
    }
    fn file_path(&self, id: &TorrentHandleId, file_index: usize) -> Option<PathBuf> {
        TorrentEngine::file_path(self, id, file_index)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineStats {
    pub torrents: u64,
    pub down_bps: u64,
    pub up_bps: u64,
}

pub trait AsyncReadSeek: AsyncRead + AsyncSeek {}
impl<T: AsyncRead + AsyncSeek> AsyncReadSeek for T {}

pub struct TorrentEngine {
    session: Arc<Session>,
    cfg: EngineConfig,
    /// Раздавать ли завершённые торренты (меняется из настроек на лету).
    seeding: std::sync::atomic::AtomicBool,
    metadata_slots: Semaphore,
    /// Выбранные для скачивания файлы по торрентам. Мьютекс сериализует `ensure_file`/`release_file`.
    selected: Arc<Mutex<HashMap<InfoHash, HashSet<usize>>>>,
}

/// Объединение множеств выбранных файлов (чистая функция для тестов).
pub fn union_selection(current: &HashSet<usize>, add: usize) -> Option<HashSet<usize>> {
    if current.contains(&add) {
        return None;
    }
    let mut next = current.clone();
    next.insert(add);
    Some(next)
}

fn to_hash(id: librqbit::dht::Id20) -> InfoHash {
    InfoHash::parse(&id.as_string()).expect("Id20 is a valid info hash")
}

fn to_id20(h: &InfoHash) -> Result<librqbit::dht::Id20, EngineError> {
    h.as_str().parse().map_err(internal)
}

/// Склеивает компоненты пути через `/`; для однофайловых торрентов путь пуст — берём имя.
pub fn join_path(components: &[String], fallback_name: &str) -> String {
    if components.is_empty() {
        fallback_name.to_string()
    } else {
        components.join("/")
    }
}

impl TorrentEngine {
    pub async fn new(cfg: EngineConfig) -> Result<Self, EngineError> {
        std::fs::create_dir_all(&cfg.data_dir)?;
        let mut opts = SessionOptions {
            fastresume: cfg.persistence,
            ..SessionOptions::default()
        };
        if !cfg.dht {
            opts.dht = None;
        }
        if cfg.persistence {
            std::fs::create_dir_all(&cfg.session_dir)?;
            opts.persistence = Some(SessionPersistenceConfig::Json {
                folder: Some(cfg.session_dir.clone()),
            });
        }
        let ip: IpAddr = if cfg.localhost_only {
            Ipv4Addr::LOCALHOST.into()
        } else {
            Ipv4Addr::UNSPECIFIED.into()
        };
        let port = cfg.listen_port.unwrap_or(0);
        opts.listen = Some(ListenerOptions {
            listen_addr: SocketAddr::new(ip, port),
            ..ListenerOptions::default()
        });
        if cfg.localhost_only {
            opts.disable_local_service_discovery = true;
        }
        let session = Session::new_with_opts(cfg.data_dir.clone(), opts)
            .await
            .map_err(internal)?;

        let engine = Self {
            session,
            seeding: std::sync::atomic::AtomicBool::new(cfg.seeding),
            cfg,
            metadata_slots: Semaphore::new(METADATA_CONCURRENCY),
            selected: Arc::new(Mutex::new(HashMap::new())),
        };
        engine.restore_selection().await;
        Ok(engine)
    }

    /// После рестарта торренты восстановлены из persistence: синхронизируем карту выбранных файлов.
    async fn restore_selection(&self) {
        let found: Vec<(InfoHash, HashSet<usize>)> = self.session.with_torrents(|it| {
            it.filter_map(|(_, h)| {
                h.only_files()
                    .map(|f| (to_hash(h.info_hash()), f.into_iter().collect()))
            })
            .collect()
        });
        let mut sel = self.selected.lock().await;
        for (hash, files) in found {
            tracing::info!(info_hash = %hash, files = files.len(), "restored torrent from session");
            sel.insert(hash, files);
        }
    }

    pub fn seeding(&self) -> bool {
        self.seeding.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Включает/выключает раздачу: при включении снимает с паузы завершённые торренты,
    /// при выключении ставит их на паузу.
    pub async fn set_seeding(&self, on: bool) {
        if self.seeding.swap(on, std::sync::atomic::Ordering::Relaxed) == on {
            return;
        }
        let handles: Vec<ManagedTorrentHandle> = self
            .session
            .with_torrents(|it| it.map(|(_, h)| h.clone()).collect());
        let _guard = self.selected.lock().await;
        for h in handles {
            let finished = h.stats().finished;
            let res = if on && h.is_paused() {
                self.session.unpause(&h).await
            } else if !on && finished && !h.is_paused() {
                self.session.pause(&h).await
            } else {
                continue;
            };
            if let Err(e) = res {
                tracing::warn!(error = %e, "cannot change seeding state of a torrent");
            }
        }
        tracing::info!(seeding = on, "seeding policy changed");
    }

    /// Сводка по движку: число торрентов и суммарные скорости (байт/с).
    pub fn stats(&self) -> EngineStats {
        let handles: Vec<ManagedTorrentHandle> = self
            .session
            .with_torrents(|it| it.map(|(_, h)| h.clone()).collect());
        let mut out = EngineStats {
            torrents: handles.len() as u64,
            ..EngineStats::default()
        };
        for h in handles {
            if let Some(live) = h.stats().live.as_ref() {
                out.down_bps += live.download_speed.as_bytes();
                out.up_bps += live.upload_speed.as_bytes();
            }
        }
        out
    }

    pub fn listen_addr(&self) -> Option<SocketAddr> {
        self.session.listen_addr()
    }

    fn handle(&self, id: &TorrentHandleId) -> Option<ManagedTorrentHandle> {
        let id20 = to_id20(&id.0).ok()?;
        self.session.get(TorrentIdOrHash::Hash(id20))
    }

    fn add_options(&self, only: Option<Vec<usize>>, list_only: bool) -> AddTorrentOptions {
        AddTorrentOptions {
            only_files: only,
            overwrite: true,
            list_only,
            initial_peers: (!self.cfg.initial_peers.is_empty())
                .then(|| self.cfg.initial_peers.clone()),
            ..AddTorrentOptions::default()
        }
    }

    fn parse_magnet(magnet: &str) -> Result<(Magnet, InfoHash), EngineError> {
        let m = Magnet::parse(magnet).map_err(|e| EngineError::InvalidMagnet(e.to_string()))?;
        let id = m
            .as_id20()
            .ok_or_else(|| EngineError::InvalidMagnet("no BitTorrent v1 info-hash".into()))?;
        Ok((m, to_hash(id)))
    }

    /// Список файлов по magnet, без скачивания данных.
    pub async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError> {
        let (_, hash) = Self::parse_magnet(magnet)?;
        async {
            // Торрент уже в сессии — сеть не нужна.
            if let Some(h) = self.handle(&TorrentHandleId(hash.clone())) {
                if let Ok(meta) = h.with_metadata(|m| meta_of(&hash, &m.info)) {
                    return Ok(meta);
                }
            }
            let _permit = self.metadata_slots.acquire().await.map_err(internal)?;
            let fut = self.session.add_torrent(
                AddTorrent::from_url(magnet.to_string()),
                Some(self.add_options(None, true)),
            );
            let resp = tokio::time::timeout(self.cfg.metadata_timeout, fut)
                .await
                .map_err(|_| EngineError::MetadataTimeout)?
                .map_err(internal)?;
            match resp {
                AddTorrentResponse::ListOnly(r) => Ok(meta_of(&hash, &r.info)),
                AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h
                    .with_metadata(|m| meta_of(&hash, &m.info))
                    .map_err(internal),
            }
        }
        .instrument(tracing::info_span!("fetch_metadata", info_hash = %hash))
        .await
    }

    /// Гарантирует, что торрент в сессии и среди скачиваемых есть `file_index`. Идемпотентно.
    pub async fn ensure_file(
        &self,
        magnet: &str,
        file_index: usize,
    ) -> Result<TorrentHandleId, EngineError> {
        let (_, hash) = Self::parse_magnet(magnet)?;
        let id = TorrentHandleId(hash.clone());
        async {
            let mut sel = self.selected.lock().await;

            if let Some(h) = self.handle(&id) {
                check_index(&h, file_index)?;
                let current = sel.entry(hash.clone()).or_default();
                if let Some(next) = union_selection(current, file_index) {
                    self.session
                        .update_only_files(&h, &next)
                        .await
                        .map_err(internal)?;
                    *current = next;
                    if h.is_paused() {
                        self.session.unpause(&h).await.map_err(internal)?;
                    }
                    self.spawn_pause_when_done(&hash, &h);
                } else if h.is_paused() && !file_is_finished(&h, file_index) {
                    self.session.unpause(&h).await.map_err(internal)?;
                    self.spawn_pause_when_done(&hash, &h);
                }
                return Ok(id.clone());
            }

            // Новый торрент: сразу с `only_files`, чтобы никогда не качать всё.
            let fut = self.session.add_torrent(
                AddTorrent::from_url(magnet.to_string()),
                Some(self.add_options(Some(vec![file_index]), false)),
            );
            let resp = tokio::time::timeout(self.cfg.metadata_timeout, fut)
                .await
                .map_err(|_| EngineError::MetadataTimeout)?
                .map_err(internal)?;
            let h = resp.into_handle().ok_or(EngineError::NotFound)?;
            if let Err(e) = check_index(&h, file_index) {
                let _ = self
                    .session
                    .delete(TorrentIdOrHash::Hash(to_id20(&hash)?), false)
                    .await;
                return Err(e);
            }
            sel.insert(hash.clone(), HashSet::from([file_index]));
            self.spawn_pause_when_done(&hash, &h);
            Ok(id.clone())
        }
        .instrument(tracing::info_span!("ensure_file", info_hash = %id.0, file_index))
        .await
    }

    /// При `seeding = false` ставит торрент на паузу, когда все выбранные файлы скачаны.
    fn spawn_pause_when_done(&self, hash: &InfoHash, h: &ManagedTorrentHandle) {
        if self.seeding() {
            return;
        }
        let (session, h, selected, hash) = (
            self.session.clone(),
            h.clone(),
            self.selected.clone(),
            hash.clone(),
        );
        tokio::spawn(async move {
            if h.wait_until_completed().await.is_err() {
                return;
            }
            // Пока ждали, могли добавить ещё файл — тогда торрент уже не завершён.
            let _guard = selected.lock().await;
            if h.stats().finished && !h.is_paused() {
                if let Err(e) = session.pause(&h).await {
                    tracing::warn!(info_hash = %hash, error = %e, "cannot pause finished torrent");
                } else {
                    tracing::debug!(info_hash = %hash, "paused finished torrent (seeding disabled)");
                }
            }
        });
    }

    /// Поток чтения файла; чтение ждёт куски, куски вокруг позиции в приоритете.
    pub async fn open_stream(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        let h = self.handle(id).ok_or(EngineError::NotFound)?;
        check_index(&h, file_index)?;
        let selected = self
            .selected
            .lock()
            .await
            .get(&id.0)
            .is_some_and(|s| s.contains(&file_index));
        if !selected {
            return Err(EngineError::NotFound);
        }
        let stream = h.stream(file_index).await.map_err(internal)?;
        Ok(Box::new(stream))
    }

    pub fn file_progress(&self, id: &TorrentHandleId, file_index: usize) -> Option<FileProgress> {
        let h = self.handle(id)?;
        let total = h
            .with_metadata(|m| m.file_infos.get(file_index).map(|f| f.len))
            .ok()??;
        let stats = h.stats();
        let done = stats.file_progress.get(file_index).copied().unwrap_or(0);
        let (peers, speed) = stats
            .live
            .as_ref()
            .map(|l| (l.snapshot.peer_stats.live, l.download_speed.as_bytes()))
            .unwrap_or((0, 0));
        Some(FileProgress {
            bytes_done: done,
            bytes_total: total,
            peers,
            down_speed_bps: speed,
            finished: done >= total,
        })
    }

    /// Абсолютный путь файла на диске.
    pub fn file_path(&self, id: &TorrentHandleId, file_index: usize) -> Option<PathBuf> {
        let h = self.handle(id)?;
        let rel = h
            .with_metadata(|m| {
                m.file_infos
                    .get(file_index)
                    .map(|f| f.relative_filename.clone())
            })
            .ok()??;
        Some(h.output_folder().join(rel))
    }

    /// Убирает файл из набора скачиваемых; без файлов торрент удаляется из сессии.
    pub async fn release_file(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
        delete_data: bool,
    ) -> Result<(), EngineError> {
        let mut sel = self.selected.lock().await;
        let Some(h) = self.handle(id) else {
            sel.remove(&id.0);
            return Err(EngineError::NotFound);
        };
        let path = self.file_path(id, file_index);
        let current = sel.entry(id.0.clone()).or_default();
        current.remove(&file_index);
        if current.is_empty() {
            sel.remove(&id.0);
            self.session
                .delete(TorrentIdOrHash::Hash(to_id20(&id.0)?), delete_data)
                .await
                .map_err(internal)?;
        } else {
            let next = current.clone();
            self.session
                .update_only_files(&h, &next)
                .await
                .map_err(internal)?;
            if delete_data {
                if let Some(p) = path {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        Ok(())
    }

    /// Выбранные файлы торрента (для диагностики и тестов).
    pub async fn selected_files(&self, id: &TorrentHandleId) -> Vec<usize> {
        let mut v: Vec<usize> = self
            .selected
            .lock()
            .await
            .get(&id.0)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        v.sort_unstable();
        v
    }

    /// Останавливает сессию (сохраняя persistence).
    pub async fn shutdown(&self) {
        self.session.stop().await;
    }
}

fn file_is_finished(h: &ManagedTorrentHandle, idx: usize) -> bool {
    let total = h
        .with_metadata(|m| m.file_infos.get(idx).map(|f| f.len))
        .ok()
        .flatten();
    let done = h.stats().file_progress.get(idx).copied();
    matches!((total, done), (Some(t), Some(d)) if d >= t)
}

fn check_index(h: &ManagedTorrentHandle, idx: usize) -> Result<(), EngineError> {
    let n = h.with_metadata(|m| m.file_infos.len()).map_err(internal)?;
    if idx < n {
        Ok(())
    } else {
        Err(EngineError::InvalidFileIndex(idx))
    }
}

fn meta_of(
    hash: &InfoHash,
    info: &librqbit::ValidatedTorrentMetaV1Info<librqbit::ByteBufOwned>,
) -> TorrentMeta {
    let name = info.name().map(|n| n.into_owned()).unwrap_or_default();
    let files = info
        .iter_file_details()
        .enumerate()
        .map(|(index, d)| FileEntry {
            index,
            path: join_path(&d.filename.to_vec(), &name),
            size: d.len,
        })
        .collect();
    TorrentMeta {
        info_hash: hash.clone(),
        name,
        files,
        piece_length: info.lengths().default_piece_length(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_union() {
        let cur = HashSet::from([1usize, 3]);
        assert_eq!(union_selection(&cur, 3), None);
        assert_eq!(union_selection(&cur, 0), Some(HashSet::from([0, 1, 3])));
        assert_eq!(
            union_selection(&HashSet::new(), 2),
            Some(HashSet::from([2]))
        );
    }

    #[test]
    fn path_joining() {
        let c = |s: &[&str]| s.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            join_path(&c(&["Album", "01 - Song.flac"]), "Album"),
            "Album/01 - Song.flac"
        );
        assert_eq!(join_path(&c(&["song.flac"]), "song.flac"), "song.flac");
        assert_eq!(join_path(&[], "single.mp3"), "single.mp3");
    }

    #[tokio::test]
    async fn invalid_magnet_is_rejected() {
        let dir = std::env::temp_dir().join(format!("nimbus-engine-{}", std::process::id()));
        let mut cfg = EngineConfig::new(&dir, false);
        cfg.dht = false;
        cfg.persistence = false;
        cfg.localhost_only = true;
        let e = TorrentEngine::new(cfg).await.unwrap();
        assert!(matches!(
            e.fetch_metadata("http://example.org").await,
            Err(EngineError::InvalidMagnet(_))
        ));
        assert!(matches!(
            e.ensure_file("not a magnet", 0).await,
            Err(EngineError::InvalidMagnet(_))
        ));
        e.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
