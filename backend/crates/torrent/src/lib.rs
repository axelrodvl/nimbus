//! Обёртка над librqbit — единственное место, которое знает про торрент-движок.
//!
//! # Блокировки и фоновые задачи
//!
//! * `state` — `std::sync::Mutex<HashMap<InfoHash, Arc<TorrentSlot>>>`: карта «торрент → слот». Берётся
//!   только на чтение/вставку записи и **никогда не держится через `.await`**.
//! * `TorrentSlot.op` — `tokio::sync::Mutex<()>` одного торрента: сериализует `ensure_files`,
//!   `release_file`, `pause_torrent`, `resume_torrent`, политику раздачи и «паузу по завершении».
//!   Операции над разными торрентами не ждут друг друга. Ожидание `op` ограничено `metadata_timeout`
//!   (`MetadataTimeout`). Порядок: сначала `op` слота, затем (кратко) `state` или `slot.selected`;
//!   две `op` одновременно не берутся (политика раздачи идёт по торрентам по одному).
//! * `TorrentSlot.selected` — выбранные файлы (`std::sync::Mutex`, без `.await`); читается без `op`
//!   (`open_stream`, `selected_files`), меняется только под `op`.
//! * `list_torrents()` и `stats()` читают только сессию librqbit и слотов не касаются.
//! * Фоновые задачи живут в `TaskTracker` и останавливаются по `CancellationToken` в `shutdown()`:
//!   одна задача ratio-watcher и не более одной «паузы по завершении» на торрент (`slot.pause_task`).

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
use tokio::sync::{OwnedMutexGuard, Semaphore};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
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
    /// Лимит раздачи: после `uploaded >= ratio * downloaded` завершённый торрент ставится на
    /// паузу. `None` — раздаём без ограничений.
    pub seed_ratio: Option<f64>,
    pub metadata_timeout: Duration,
    /// Как часто проверять лимит раздачи (`seed_ratio`) у завершённых торрентов.
    pub ratio_check_interval: Duration,
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
            seed_ratio: None,
            metadata_timeout: Duration::from_secs(45),
            ratio_check_interval: Duration::from_secs(30),
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
    /// Ошибка хранилища: нет места, нет прав, файловая система только для чтения.
    #[error("storage error: {0}")]
    Storage(String),
    #[error("{0}")]
    Internal(String),
}

fn internal(e: impl std::fmt::Display) -> EngineError {
    EngineError::Internal(format!("{e:#}"))
}

/// Ошибка `add_torrent`. Если конечный список пиров (initial_peers) исчерпан, а метаданных нет,
/// librqbit возвращает ошибку сразу, не дожидаясь нашего таймаута. Для вызывающих это то же самое,
/// что таймаут («метаданные не получены»), поэтому и мапим в `MetadataTimeout`.
fn add_error(e: impl std::fmt::Display) -> EngineError {
    let msg = format!("{e:#}");
    if msg.contains("no way to discover torrent metainfo") {
        EngineError::MetadataTimeout
    } else if let Some(i) = out_of_range_index(&msg) {
        EngineError::InvalidFileIndex(i)
    } else if is_storage_message(&msg) {
        EngineError::Storage(msg)
    } else {
        EngineError::Internal(msg)
    }
}

/// librqbit отклоняет `only_files` с несуществующим индексом сообщением «file id N is out of range».
fn out_of_range_index(msg: &str) -> Option<usize> {
    let rest = msg.split("file id ").nth(1)?;
    let (num, tail) = rest.split_once(' ')?;
    tail.starts_with("is out of range")
        .then(|| num.parse().ok())
        .flatten()
}

/// Похоже ли сообщение на ошибку диска (нет места, нет прав, read-only, квота).
fn is_storage_message(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "no space left",
        "permission denied",
        "read-only file system",
        "disk quota",
        "not enough space",
        "os error",
    ]
    .iter()
    .any(|p| m.contains(p))
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
    /// Несколько файлов за один вызов (по умолчанию — цикл `ensure_file`).
    async fn ensure_files(
        &self,
        magnet: &str,
        file_indexes: &[usize],
    ) -> Result<TorrentHandleId, EngineError> {
        let mut id = None;
        for &i in file_indexes {
            id = Some(self.ensure_file(magnet, i).await?);
        }
        id.ok_or_else(|| EngineError::Internal("no files requested".into()))
    }
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
    async fn ensure_files(
        &self,
        magnet: &str,
        file_indexes: &[usize],
    ) -> Result<TorrentHandleId, EngineError> {
        TorrentEngine::ensure_files(self, magnet, file_indexes).await
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

/// Состояние торрента для менеджера загрузок.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentState {
    /// Проверка файлов / инициализация.
    Initializing,
    /// Качается (не завершён, не на паузе).
    Downloading,
    /// Завершён и раздаётся.
    Seeding,
    /// Остановлен вручную или по политике раздачи.
    Paused,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TorrentInfo {
    pub info_hash: InfoHash,
    pub name: String,
    pub state: TorrentState,
    pub error: Option<String>,
    pub finished: bool,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
    /// Подключённые пиры (включая сидов).
    pub peers: u32,
    /// Из подключённых пиров — сиды (есть все куски).
    pub seeds: u32,
}

pub trait AsyncReadSeek: AsyncRead + AsyncSeek {}
impl<T: AsyncRead + AsyncSeek> AsyncReadSeek for T {}

/// Слот торрента: всё, что относится к одному торренту и сериализуется его блокировкой.
struct TorrentSlot {
    /// Сериализует операции над торрентом.
    op: Arc<tokio::sync::Mutex<()>>,
    /// Выбранные для скачивания файлы.
    selected: std::sync::Mutex<HashSet<usize>>,
    /// Ожидание завершения для «паузы по завершении»: не более одной задачи на торрент.
    pause_task: std::sync::Mutex<Option<AbortHandle>>,
}

impl TorrentSlot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            op: Arc::new(tokio::sync::Mutex::new(())),
            selected: std::sync::Mutex::new(HashSet::new()),
            pause_task: std::sync::Mutex::new(None),
        })
    }

    fn selection(&self) -> HashSet<usize> {
        lock_std(&self.selected).clone()
    }

    fn set_selection(&self, files: HashSet<usize>) {
        *lock_std(&self.selected) = files;
    }

    /// Подменяет задачу «паузы по завершении»; предыдущая прерывается.
    fn replace_pause_task(&self, new: Option<AbortHandle>) {
        if let Some(old) = std::mem::replace(&mut *lock_std(&self.pause_task), new) {
            old.abort();
        }
    }
}

fn lock_std<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

type SlotMap = Arc<std::sync::Mutex<HashMap<InfoHash, Arc<TorrentSlot>>>>;

/// Берёт `op` слота торрента (создаёт слот при `create`), ожидая не дольше `wait`.
/// `Ok(None)` — слота нет и создавать не просили. Если слот успели удалить, пока ждали, берём заново.
async fn lock_slot(
    state: &SlotMap,
    hash: &InfoHash,
    create: bool,
    wait: Duration,
) -> Result<Option<(Arc<TorrentSlot>, OwnedMutexGuard<()>)>, EngineError> {
    loop {
        let slot = {
            let mut map = lock_std(state);
            match map.get(hash) {
                Some(s) => s.clone(),
                None if create => {
                    let s = TorrentSlot::new();
                    map.insert(hash.clone(), s.clone());
                    s
                }
                None => return Ok(None),
            }
        };
        let guard = tokio::time::timeout(wait, slot.op.clone().lock_owned())
            .await
            .map_err(|_| EngineError::MetadataTimeout)?;
        let current = lock_std(state)
            .get(hash)
            .is_some_and(|c| Arc::ptr_eq(c, &slot));
        if current {
            return Ok(Some((slot, guard)));
        }
    }
}

/// Убирает слот (вызывать под его `op`) и прерывает его фоновую задачу.
fn remove_slot(state: &SlotMap, hash: &InfoHash) {
    if let Some(slot) = lock_std(state).remove(hash) {
        slot.replace_pause_task(None);
    }
}

/// Сколько фоновые задачи ждут `op` торрента; дольше — пропускаем (торрент занят долгой операцией).
const BACKGROUND_LOCK_WAIT: Duration = Duration::from_secs(5);
/// Сколько `shutdown` ждёт фоновые задачи.
const SHUTDOWN_TASKS_WAIT: Duration = Duration::from_secs(5);

pub struct TorrentEngine {
    session: Arc<Session>,
    cfg: EngineConfig,
    /// Раздавать ли завершённые торренты (меняется из настроек на лету).
    seeding: std::sync::atomic::AtomicBool,
    /// Лимит раздачи (uploaded / downloaded); `None` — без лимита. Хранится как биты `f64`
    /// (`u64::MAX` — нет лимита), меняется на лету.
    seed_ratio: Arc<std::sync::atomic::AtomicU64>,
    metadata_slots: Semaphore,
    /// Слоты торрентов (см. описание модуля).
    state: SlotMap,
    tasks: TaskTracker,
    cancel: CancellationToken,
    stopped: std::sync::atomic::AtomicBool,
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

fn encode_ratio(r: Option<f64>) -> u64 {
    r.map_or(u64::MAX, f64::to_bits)
}

fn decode_ratio(bits: u64) -> Option<f64> {
    (bits != u64::MAX).then(|| f64::from_bits(bits))
}

/// Чистое правило лимита раздачи: завершённый торрент, у которого `uploaded >= ratio * downloaded`.
pub fn ratio_hit(finished: bool, downloaded: u64, uploaded: u64, ratio: Option<f64>) -> bool {
    match ratio {
        Some(r) if finished && downloaded > 0 => uploaded as f64 >= r * downloaded as f64,
        _ => false,
    }
}

/// Достигнут ли лимит раздачи: `uploaded >= ratio * downloaded`.
pub fn ratio_reached(st: &librqbit::TorrentStats, ratio: Option<f64>) -> bool {
    ratio_hit(st.finished, st.progress_bytes, st.uploaded_bytes, ratio)
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

/// Порт свободен и по TCP, и по UDP (uTP) на заданном адресе.
fn port_is_free(ip: IpAddr, port: u16) -> bool {
    std::net::TcpListener::bind((ip, port)).is_ok() && std::net::UdpSocket::bind((ip, port)).is_ok()
}

fn handles_of(session: &Session) -> Vec<ManagedTorrentHandle> {
    session.with_torrents(|it| it.map(|(_, h)| h.clone()).collect())
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
        let mut port = cfg.listen_port.unwrap_or(0);
        if port != 0 && !port_is_free(ip, port) {
            tracing::warn!(
                port,
                "BitTorrent port is busy, falling back to a random port"
            );
            port = 0;
        }
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
            seed_ratio: Arc::new(std::sync::atomic::AtomicU64::new(encode_ratio(
                cfg.seed_ratio,
            ))),
            cfg,
            metadata_slots: Semaphore::new(METADATA_CONCURRENCY),
            state: Arc::new(std::sync::Mutex::new(HashMap::new())),
            tasks: TaskTracker::new(),
            cancel: CancellationToken::new(),
            stopped: std::sync::atomic::AtomicBool::new(false),
        };
        engine.restore_selection();
        engine.spawn_ratio_watcher();
        Ok(engine)
    }

    /// После рестарта торренты восстановлены из persistence: синхронизируем выбранные файлы.
    fn restore_selection(&self) {
        let found: Vec<(InfoHash, HashSet<usize>)> = self.session.with_torrents(|it| {
            it.filter_map(|(_, h)| {
                h.only_files()
                    .map(|f| (to_hash(h.info_hash()), f.into_iter().collect()))
            })
            .collect()
        });
        let mut map = lock_std(&self.state);
        for (hash, files) in found {
            tracing::info!(info_hash = %hash, files = files.len(), "restored torrent from session");
            let slot = TorrentSlot::new();
            slot.set_selection(files);
            map.insert(hash, slot);
        }
    }

    pub fn seeding(&self) -> bool {
        self.seeding.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Применяет `f` к каждому торренту сессии по очереди, беря `op` его слота (не дольше
    /// `BACKGROUND_LOCK_WAIT`: занятый долгой операцией торрент пропускается).
    async fn for_each_torrent<F, Fut>(&self, f: F)
    where
        F: Fn(ManagedTorrentHandle) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        for_each_torrent(&self.session, &self.state, f).await;
    }

    /// Включает/выключает раздачу: при включении снимает с паузы завершённые торренты,
    /// при выключении ставит их на паузу.
    pub async fn set_seeding(&self, on: bool) {
        if self.seeding.swap(on, std::sync::atomic::Ordering::Relaxed) == on {
            return;
        }
        let session = self.session.clone();
        let ratio = self.seed_ratio.clone();
        self.for_each_torrent(|h| {
            let session = session.clone();
            let ratio = ratio.clone();
            async move {
                let st = h.stats();
                let limit = decode_ratio(ratio.load(std::sync::atomic::Ordering::Relaxed));
                let res = if on && h.is_paused() && !ratio_reached(&st, limit) {
                    session.unpause(&h).await
                } else if !on && st.finished && !h.is_paused() {
                    session.pause(&h).await
                } else {
                    return;
                };
                if let Err(e) = res {
                    tracing::warn!(error = %e, "cannot change seeding state of a torrent");
                }
            }
        })
        .await;
        tracing::info!(seeding = on, "seeding policy changed");
    }

    pub fn seed_ratio(&self) -> Option<f64> {
        decode_ratio(self.seed_ratio.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Меняет лимит раздачи на лету: завершённые торренты ниже нового лимита снимаются с паузы
    /// (если раздача включена), достигшие его — ставятся на паузу ближайшей проверкой.
    pub async fn set_seed_ratio(&self, ratio: Option<f64>) {
        let new = encode_ratio(ratio);
        if self
            .seed_ratio
            .swap(new, std::sync::atomic::Ordering::Relaxed)
            == new
        {
            return;
        }
        if self.seeding() {
            let session = self.session.clone();
            self.for_each_torrent(|h| {
                let session = session.clone();
                async move {
                    let st = h.stats();
                    if st.finished && h.is_paused() && !ratio_reached(&st, ratio) {
                        if let Err(e) = session.unpause(&h).await {
                            tracing::warn!(error = %e, "cannot resume seeding of a torrent");
                        }
                    }
                }
            })
            .await;
        }
        tracing::info!(?ratio, "seed ratio changed");
    }

    /// Фоновая проверка лимита раздачи: завершённые торренты, достигшие его, ставятся на паузу.
    fn spawn_ratio_watcher(&self) {
        let (session, state, ratio, cancel) = (
            self.session.clone(),
            self.state.clone(),
            self.seed_ratio.clone(),
            self.cancel.clone(),
        );
        let period = self.cfg.ratio_check_interval;
        self.tasks.spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tick.tick() => {}
                }
                let Some(limit) = decode_ratio(ratio.load(std::sync::atomic::Ordering::Relaxed))
                else {
                    continue;
                };
                for_each_torrent(&session, &state, |h| {
                    let session = session.clone();
                    async move {
                        let st = h.stats();
                        let live = matches!(st.state, librqbit::TorrentStatsState::Live);
                        if live && ratio_reached(&st, Some(limit)) {
                            match session.pause(&h).await {
                                Ok(()) => tracing::info!(
                                    info_hash = %h.info_hash().as_string(),
                                    uploaded = st.uploaded_bytes,
                                    downloaded = st.progress_bytes,
                                    "seed ratio reached, torrent paused"
                                ),
                                Err(e) => tracing::warn!(error = %e, "cannot pause seeded torrent"),
                            }
                        }
                    }
                })
                .await;
            }
        });
    }

    /// Сводка по движку: число торрентов и суммарные скорости (байт/с). Слотов не касается.
    pub fn stats(&self) -> EngineStats {
        let handles = handles_of(&self.session);
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

    /// Все торренты сессии со статусом, пирами и скоростями (для менеджера загрузок).
    /// Слотов не касается: не ждёт долгих операций над торрентами.
    pub fn list_torrents(&self) -> Vec<TorrentInfo> {
        let handles = handles_of(&self.session);
        let mut out: Vec<TorrentInfo> = handles.iter().map(torrent_info).collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    /// Ставит торрент на паузу (остановка скачивания и раздачи).
    pub async fn pause_torrent(&self, id: &TorrentHandleId) -> Result<(), EngineError> {
        let h = self.handle(id).ok_or(EngineError::NotFound)?;
        let _op = self.lock_existing(&id.0).await?;
        if !h.is_paused() {
            self.session.pause(&h).await.map_err(internal)?;
        }
        Ok(())
    }

    /// Запускает торрент. Если лимит раздачи уже достигнут, фоновая проверка снова остановит
    /// завершённый торрент.
    pub async fn resume_torrent(&self, id: &TorrentHandleId) -> Result<(), EngineError> {
        let h = self.handle(id).ok_or(EngineError::NotFound)?;
        let _op = self.lock_existing(&id.0).await?;
        if h.is_paused() {
            self.session.unpause(&h).await.map_err(internal)?;
        }
        Ok(())
    }

    /// `op` торрента, который есть в сессии (слот создаётся, если его ещё нет).
    async fn lock_existing(
        &self,
        hash: &InfoHash,
    ) -> Result<(Arc<TorrentSlot>, OwnedMutexGuard<()>), EngineError> {
        lock_slot(&self.state, hash, true, self.cfg.metadata_timeout)
            .await?
            .ok_or(EngineError::NotFound)
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
                .map_err(add_error)?;
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
        self.ensure_files(magnet, &[file_index]).await
    }

    /// Гарантирует, что торрент в сессии и среди скачиваемых есть все `file_indexes`
    /// (один `update_only_files` на набор). Идемпотентно; параллельные вызовы для одного
    /// торрента выстраиваются по очереди, для разных — независимы.
    pub async fn ensure_files(
        &self,
        magnet: &str,
        file_indexes: &[usize],
    ) -> Result<TorrentHandleId, EngineError> {
        let (_, hash) = Self::parse_magnet(magnet)?;
        let id = TorrentHandleId(hash.clone());
        if file_indexes.is_empty() {
            return Err(EngineError::Internal("no files requested".into()));
        }
        let want: HashSet<usize> = file_indexes.iter().copied().collect();
        async {
            let wait = self.cfg.metadata_timeout;
            let (slot, _op) = lock_slot(&self.state, &hash, true, wait)
                .await?
                .ok_or(EngineError::NotFound)?;

            let mut existing = self.handle(&id);
            if let Some(h) = &existing {
                if self.recover_errored(&hash, h).await {
                    existing = None;
                }
            }
            if let Some(h) = existing {
                return self
                    .extend_selection(&slot, &hash, &h, &want)
                    .await
                    .map(|()| id.clone());
            }

            // Новый торрент: сразу с `only_files`, чтобы никогда не качать всё.
            let mut only: Vec<usize> = want.iter().copied().collect();
            only.sort_unstable();
            let fut = self.session.add_torrent(
                AddTorrent::from_url(magnet.to_string()),
                Some(self.add_options(Some(only), false)),
            );
            let added = match tokio::time::timeout(wait, fut).await {
                Err(_) => Err(EngineError::MetadataTimeout),
                Ok(Err(e)) => Err(add_error(e)),
                Ok(Ok(resp)) => resp.into_handle().ok_or(EngineError::NotFound),
            };
            let h = match added {
                Ok(h) => h,
                Err(e) => {
                    self.discard_unselected(&slot, &hash).await;
                    return Err(e);
                }
            };
            if let Some(e) = want.iter().find_map(|&f| check_index(&h, f).err()) {
                self.discard_unselected(&slot, &hash).await;
                return Err(e);
            }
            slot.set_selection(want);
            self.spawn_pause_when_done(&slot, &hash, &h);
            Ok(id.clone())
        }
        .instrument(
            tracing::info_span!("ensure_files", info_hash = %id.0, files = file_indexes.len()),
        )
        .await
    }

    /// Торрент уже в сессии: расширяет выбор и при необходимости снимает с паузы (под `op`).
    async fn extend_selection(
        &self,
        slot: &Arc<TorrentSlot>,
        hash: &InfoHash,
        h: &ManagedTorrentHandle,
        want: &HashSet<usize>,
    ) -> Result<(), EngineError> {
        for &f in want {
            check_index(h, f)?;
        }
        let current = slot.selection();
        let mut next = current.clone();
        next.extend(want.iter().copied());
        if next != current {
            self.wait_initialized(h).await?;
            self.session
                .update_only_files(h, &next)
                .await
                .map_err(internal)?;
            slot.set_selection(next);
            if h.is_paused() {
                self.session.unpause(h).await.map_err(internal)?;
            }
            self.spawn_pause_when_done(slot, hash, h);
        } else if h.is_paused() && want.iter().any(|&f| !file_is_finished(h, f)) {
            self.session.unpause(h).await.map_err(internal)?;
            self.spawn_pause_when_done(slot, hash, h);
        }
        Ok(())
    }

    /// `update_only_files` не работает у торрента в проверке файлов: ждём выхода из неё.
    async fn wait_initialized(&self, h: &ManagedTorrentHandle) -> Result<(), EngineError> {
        let deadline = tokio::time::Instant::now() + self.cfg.metadata_timeout;
        while matches!(
            h.stats().state,
            librqbit::TorrentStatsState::Initializing { .. }
        ) {
            if tokio::time::Instant::now() >= deadline {
                return Err(EngineError::MetadataTimeout);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    /// Торрент в состоянии `Error`: пишем причину и перезапускаем (`unpause`); если не вышло —
    /// удаляем из сессии, и вызывающий добавит его заново. `true` — торрент удалён.
    async fn recover_errored(&self, hash: &InfoHash, h: &ManagedTorrentHandle) -> bool {
        let st = h.stats();
        if !matches!(st.state, librqbit::TorrentStatsState::Error) {
            return false;
        }
        tracing::warn!(info_hash = %hash, error = ?st.error, "torrent is in error state, restarting");
        if self.session.unpause(h).await.is_ok() {
            let _ = self.wait_initialized(h).await;
            if !matches!(h.stats().state, librqbit::TorrentStatsState::Error) {
                return false;
            }
        }
        tracing::warn!(info_hash = %hash, "restart did not help, re-adding the torrent");
        match to_id20(hash) {
            Ok(id20) => {
                let _ = self
                    .session
                    .delete(TorrentIdOrHash::Hash(id20), false)
                    .await;
                true
            }
            Err(_) => false,
        }
    }

    /// Очистка после неудачного добавления: торрент без выбранных файлов не должен оставаться
    /// ни в сессии, ни в слотах (иначе он был бы утечкой: не раздаётся и не удаляется).
    async fn discard_unselected(&self, slot: &Arc<TorrentSlot>, hash: &InfoHash) {
        if !slot.selection().is_empty() {
            return;
        }
        if let Ok(id20) = to_id20(hash) {
            if self.session.get(TorrentIdOrHash::Hash(id20)).is_some() {
                if let Err(e) = self
                    .session
                    .delete(TorrentIdOrHash::Hash(id20), false)
                    .await
                {
                    tracing::warn!(info_hash = %hash, error = %e, "cannot remove torrent after failed add");
                }
            }
        }
        remove_slot(&self.state, hash);
    }

    /// При `seeding = false` ставит торрент на паузу, когда все выбранные файлы скачаны.
    /// На торрент — не больше одной такой задачи (предыдущая прерывается).
    fn spawn_pause_when_done(
        &self,
        slot: &Arc<TorrentSlot>,
        hash: &InfoHash,
        h: &ManagedTorrentHandle,
    ) {
        if self.seeding() {
            slot.replace_pause_task(None);
            return;
        }
        let (session, h, slot_task, hash, cancel) = (
            self.session.clone(),
            h.clone(),
            slot.clone(),
            hash.clone(),
            self.cancel.clone(),
        );
        let handle = self.tasks.spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => return,
                // Ошибка — торрент удалён из сессии: тихо выходим.
                r = h.wait_until_completed() => if r.is_err() { return },
            }
            // Пока ждали, могли добавить ещё файл — тогда торрент уже не завершён.
            let _op = slot_task.op.lock().await;
            if h.stats().finished && !h.is_paused() {
                if let Err(e) = session.pause(&h).await {
                    tracing::warn!(info_hash = %hash, error = %e, "cannot pause finished torrent");
                } else {
                    tracing::debug!(info_hash = %hash, "paused finished torrent (seeding disabled)");
                }
            }
        });
        slot.replace_pause_task(Some(handle.abort_handle()));
    }

    /// Поток чтения файла; чтение ждёт куски, куски вокруг позиции в приоритете.
    pub async fn open_stream(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        let h = self.handle(id).ok_or(EngineError::NotFound)?;
        check_index(&h, file_index)?;
        if !self.selection_of(&id.0).contains(&file_index) {
            return Err(EngineError::NotFound);
        }
        let stream = h.stream(file_index).await.map_err(internal)?;
        Ok(Box::new(stream))
    }

    fn selection_of(&self, hash: &InfoHash) -> HashSet<usize> {
        lock_std(&self.state)
            .get(hash)
            .map(|s| s.selection())
            .unwrap_or_default()
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
        let Some((slot, _op)) =
            lock_slot(&self.state, &id.0, false, self.cfg.metadata_timeout).await?
        else {
            return Err(EngineError::NotFound);
        };
        let Some(h) = self.handle(id) else {
            remove_slot(&self.state, &id.0);
            return Err(EngineError::NotFound);
        };
        let path = self.file_path(id, file_index);
        let mut next = slot.selection();
        next.remove(&file_index);
        if next.is_empty() {
            self.session
                .delete(TorrentIdOrHash::Hash(to_id20(&id.0)?), delete_data)
                .await
                .map_err(internal)?;
            remove_slot(&self.state, &id.0);
        } else {
            self.wait_initialized(&h).await?;
            self.session
                .update_only_files(&h, &next)
                .await
                .map_err(internal)?;
            slot.set_selection(next);
            if delete_data {
                if let Some(p) = path {
                    // Файл мог быть не создан (не скачивался): отсутствие — не ошибка.
                    if let Err(e) = std::fs::remove_file(&p) {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            return Err(EngineError::Storage(format!("{}: {e}", p.display())));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Выбранные файлы торрента (для диагностики и тестов).
    pub async fn selected_files(&self, id: &TorrentHandleId) -> Vec<usize> {
        let mut v: Vec<usize> = self.selection_of(&id.0).into_iter().collect();
        v.sort_unstable();
        v
    }

    /// Сколько торрентов отслеживается слотами (диагностика и тесты: после неудачного добавления — 0).
    pub fn tracked_torrents(&self) -> usize {
        lock_std(&self.state).len()
    }

    /// Сколько фоновых задач движка ещё живо (после `shutdown` — 0).
    pub fn background_tasks(&self) -> usize {
        self.tasks.len()
    }

    /// Останавливает фоновые задачи и сессию (сохраняя persistence). Повторный вызов безопасен.
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        self.tasks.close();
        if tokio::time::timeout(SHUTDOWN_TASKS_WAIT, self.tasks.wait())
            .await
            .is_err()
        {
            tracing::warn!("background tasks did not stop in time");
        }
        if !self.stopped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.session.stop().await;
        }
    }
}

/// Проходит торренты сессии по одному, беря `op` слота каждого (не дольше `BACKGROUND_LOCK_WAIT`).
async fn for_each_torrent<F, Fut>(session: &Session, state: &SlotMap, f: F)
where
    F: Fn(ManagedTorrentHandle) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    for h in handles_of(session) {
        let hash = to_hash(h.info_hash());
        match lock_slot(state, &hash, true, BACKGROUND_LOCK_WAIT).await {
            Ok(Some((_slot, _op))) => f(h).await,
            Ok(None) => {}
            Err(_) => tracing::warn!(info_hash = %hash, "torrent is busy, skipped"),
        }
    }
}

fn torrent_info(h: &ManagedTorrentHandle) -> TorrentInfo {
    use librqbit::TorrentStatsState as S;
    let st = h.stats();
    let state = match st.state {
        S::Error => TorrentState::Error,
        S::Paused => TorrentState::Paused,
        S::Initializing { paused: true } => TorrentState::Paused,
        S::Initializing { paused: false } => TorrentState::Initializing,
        S::Live if st.finished => TorrentState::Seeding,
        S::Live => TorrentState::Downloading,
    };
    let (down_bps, up_bps, peers, seeds) = st.live.as_ref().map_or((0, 0, 0, 0), |l| {
        (
            l.download_speed.as_bytes(),
            l.upload_speed.as_bytes(),
            l.snapshot.peer_stats.live,
            l.snapshot.peer_stats.live_seeders,
        )
    });
    TorrentInfo {
        info_hash: to_hash(h.info_hash()),
        name: h.name().unwrap_or_else(|| h.info_hash().as_string()),
        state,
        error: st.error.clone(),
        finished: st.finished,
        progress_bytes: st.progress_bytes,
        total_bytes: st.total_bytes,
        uploaded_bytes: st.uploaded_bytes,
        down_bps,
        up_bps,
        peers,
        seeds,
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
    fn ratio_hit_boundaries() {
        // Нет лимита / не завершён / ничего не скачано — никогда.
        assert!(!ratio_hit(true, 100, 1000, None));
        assert!(!ratio_hit(false, 100, 1000, Some(1.0)));
        assert!(!ratio_hit(true, 0, 1000, Some(1.0)));
        // Граница: uploaded == ratio * downloaded — достигнут; на байт меньше — нет.
        assert!(ratio_hit(true, 100, 100, Some(1.0)));
        assert!(!ratio_hit(true, 100, 99, Some(1.0)));
        assert!(ratio_hit(true, 100, 150, Some(1.5)));
        assert!(!ratio_hit(true, 100, 149, Some(1.5)));
        assert!(ratio_hit(true, 100, 0, Some(0.0)));
    }

    #[test]
    fn ratio_encoding_roundtrips() {
        assert_eq!(decode_ratio(encode_ratio(None)), None);
        assert_eq!(decode_ratio(encode_ratio(Some(1.5))), Some(1.5));
        assert_eq!(decode_ratio(encode_ratio(Some(0.0))), Some(0.0));
    }

    #[test]
    fn storage_errors_are_recognised() {
        assert!(is_storage_message(
            "write failed: No space left on device (os error 28)"
        ));
        assert!(is_storage_message("Permission denied (os error 13)"));
        assert!(is_storage_message("Read-only file system"));
        assert!(is_storage_message("File exists (os error 17)"));
        assert!(!is_storage_message("connection reset by peer"));
        assert!(matches!(
            add_error("creating output file: No space left on device"),
            EngineError::Storage(_)
        ));
        assert!(matches!(
            add_error("error: no way to discover torrent metainfo"),
            EngineError::MetadataTimeout
        ));
        assert!(matches!(add_error("boom"), EngineError::Internal(_)));
        assert!(matches!(
            add_error("file id 99 is out of range"),
            EngineError::InvalidFileIndex(99)
        ));
        assert_eq!(out_of_range_index("file id x is out of range"), None);
        assert_eq!(out_of_range_index("file id 7 is fine"), None);
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
