//! Менеджер загрузок на сервер (шаг 33): закреплённые треки качаются явно, а не «по случаю прослушивания».
//!
//! Менеджер только инициирует загрузки и следит за закреплениями (`pinned_tracks`): переход
//! `found → ready` остаётся за `Watcher` (`stream.rs`). Закрепление привязано к треку; файл
//! вычисляется по primary-источнику в момент работы.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::FutureExt;
use nimbus_core::events::Event;
use nimbus_core::model::{InfoHash, NewDownload, PinState, TrackSource, TrackStatus};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::pins::{self, PinWork};
use nimbus_db::repo::{downloads, torrents, track_sources};
use nimbus_torrent::{EngineError, FileProvider, TorrentHandleId};
use nimbus_worker::torrent_file;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

/// Живая статистика закреплённых загрузок альбома (для `AcquisitionItem.download`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Live {
    pub down_bps: u64,
    pub peers: u32,
}

/// Связь менеджера с API: будильник и живая статистика по альбомам.
#[derive(Clone, Default)]
pub struct DownloadHub {
    notify: Arc<Notify>,
    live: Arc<Mutex<HashMap<i64, Live>>>,
}

impl DownloadHub {
    /// Будит менеджер: закрепления изменились.
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// Скорость и пиры закреплённых загрузок альбома (нули, если ничего не качается).
    pub fn live(&self, album_id: i64) -> Live {
        self.live
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&album_id)
            .copied()
            .unwrap_or_default()
    }

    fn replace_live(&self, next: HashMap<i64, Live>) {
        *self.live.lock().unwrap_or_else(PoisonError::into_inner) = next;
    }
}

/// Параметры менеджера (в тестах — малые значения).
#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Период тика.
    pub tick: Duration,
    /// Не чаще, чем раз в это время, публикуется `download.progress`.
    pub progress_every: Duration,
    /// Сколько файл может не двигаться, прежде чем источник будет заменён.
    pub stall_timeout: Duration,
    /// Через сколько `failed` повторяется автоматически.
    pub retry_after: Duration,
    /// Сколько авто-повторов, затем закрепление остаётся `failed`.
    pub max_retries: i32,
    /// Пауза перед перезапуском менеджера после паники в тике.
    pub restart_pause: Duration,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(1),
            progress_every: Duration::from_secs(1),
            stall_timeout: Duration::from_secs(600),
            retry_after: Duration::from_secs(3600),
            max_retries: 5,
            restart_pause: Duration::from_secs(1),
        }
    }
}

/// Файл торрента: `(torrent_id, file_index)`.
type FileKey = (i64, i32);

pub struct DownloadManager {
    state: AppState,
    cfg: ManagerConfig,
    /// Последний замеченный прогресс файла и когда он менялся (для обнаружения зависания).
    stalls: HashMap<FileKey, (u64, Instant)>,
    /// Источники трека, на которых загрузка уже зависала: по кругу между ними не ходим.
    tried: HashMap<i64, Vec<i64>>,
    /// Торренты, которые менеджер поставил на паузу (их нужно возобновить).
    paused_torrents: HashSet<i64>,
    last_progress: Option<Instant>,
}

impl DownloadManager {
    pub fn new(state: AppState, cfg: ManagerConfig) -> Self {
        Self {
            state,
            cfg,
            stalls: HashMap::new(),
            tried: HashMap::new(),
            paused_torrents: HashSet::new(),
            last_progress: None,
        }
    }

    /// Старт процесса: закрепления `downloading` → `queued` (движок восстановит торренты из сессии,
    /// менеджер заново вызовет `ensure_files` — это идемпотентно).
    pub async fn startup(state: &AppState) -> sqlx::Result<u64> {
        pins::requeue_downloading(&state.db).await
    }

    /// Меняет состояние закрепления и сообщает об изменении приобретения альбома.
    async fn set(&self, p: &PinWork, state: PinState, error: Option<&str>) -> sqlx::Result<()> {
        pins::set_state(&self.state.db, p.track_id, state, error).await?;
        self.state.events.publish_acquisition_changed(p.album_id);
        Ok(())
    }

    /// Один проход: авто-повтор `failed`, переходы состояний, запуск новых загрузок в пределах
    /// `download_concurrency`, пауза/возобновление, прогресс.
    pub async fn tick(&mut self) -> sqlx::Result<()> {
        let Some(files) = self.state.files.clone() else {
            return Ok(());
        };
        let db = &self.state.db;
        let paused = nimbus_db::settings::downloads_paused(db).await?;
        for track_id in
            pins::retry_failed(db, self.cfg.retry_after.as_secs_f64(), self.cfg.max_retries).await?
        {
            tracing::info!(track_id, "pinned download retried automatically");
        }

        let open = pins::list_open(db).await?;
        let keys: Vec<FileKey> = open
            .iter()
            .filter_map(|p| Some((p.torrent_id?, p.file_index?)))
            .collect();
        let existing: HashMap<FileKey, nimbus_core::model::Download> =
            downloads::get_many(db, &keys)
                .await?
                .into_iter()
                .map(|d| ((d.torrent_id, d.file_index), d))
                .collect();

        // Классификация. `active` — торренты, в которых уже что-то качается ради закреплений.
        let mut active: HashSet<i64> = HashSet::new();
        let mut downloading: Vec<&PinWork> = Vec::new();
        let mut queued: Vec<(&PinWork, FileKey)> = Vec::new();
        for p in &open {
            let ready_for_download =
                matches!(p.track_status, TrackStatus::Found | TrackStatus::Ready);
            let (Some(torrent_id), Some(file_index), true) =
                (p.torrent_id, p.file_index, ready_for_download)
            else {
                if p.state != PinState::WaitingSource {
                    self.set(p, PinState::WaitingSource, None).await?;
                }
                continue;
            };
            let key = (torrent_id, file_index);
            if existing.get(&key).is_some_and(|d| d.completed_at.is_some()) {
                // `done` с треком в `found` — Watcher вот-вот переведёт его в `ready`.
                if p.state != PinState::Done {
                    self.set(p, PinState::Done, None).await?;
                }
                self.stalls.remove(&key);
                self.tried.remove(&p.track_id);
                continue;
            }
            match p.state {
                PinState::Downloading => {
                    active.insert(torrent_id);
                    downloading.push(p);
                }
                // `done`, но файла нет (пропал с диска) — качаем заново.
                PinState::Queued | PinState::WaitingSource | PinState::Done => {
                    if p.state == PinState::WaitingSource {
                        // Источник нашёлся: ждём теперь только свободного слота.
                        self.set(p, PinState::Queued, None).await?;
                    }
                    queued.push((p, key));
                }
                PinState::Failed => {}
            }
        }

        // Зависание.
        let mut still: Vec<&PinWork> = Vec::new();
        for p in downloading {
            if self.is_stalled(&files, p) {
                self.handle_stall(p).await?;
                active.remove(&p.torrent_id.unwrap_or_default());
            } else {
                still.push(p);
            }
        }
        // `active` мог потерять торрент, у которого остались другие файлы.
        for p in &still {
            active.extend(p.torrent_id);
        }

        // Пауза / возобновление.
        if paused {
            self.pause_pinned(&files, &open).await;
        } else if !self.paused_torrents.is_empty() {
            self.resume_paused(&files).await;
        }

        // Запуск новых.
        if !paused && !queued.is_empty() {
            let limit = usize::from(self.state.settings.get().performance.download_concurrency);
            let mut groups: BTreeMap<i64, (usize, Vec<&PinWork>)> = BTreeMap::new();
            for (order, (p, key)) in queued.iter().enumerate() {
                groups
                    .entry(key.0)
                    .or_insert_with(|| (order, Vec::new()))
                    .1
                    .push(p);
            }
            let mut ordered: Vec<(i64, usize, Vec<&PinWork>)> = groups
                .into_iter()
                .map(|(t, (order, v))| (t, order, v))
                .collect();
            ordered.sort_by_key(|(_, order, _)| *order);
            let mut free = limit.saturating_sub(active.len());
            let mut chosen = Vec::new();
            for (torrent_id, _, pins_of) in ordered {
                // Торрент, который уже качается, берёт новые файлы без нового слота.
                if active.contains(&torrent_id) {
                    chosen.push((torrent_id, pins_of));
                } else if free > 0 {
                    free -= 1;
                    active.insert(torrent_id);
                    chosen.push((torrent_id, pins_of));
                }
            }
            let results = futures::future::join_all(
                chosen
                    .iter()
                    .map(|(torrent_id, pins_of)| self.start_group(&files, *torrent_id, pins_of)),
            )
            .await;
            for ((_, pins_of), result) in chosen.iter().zip(results) {
                match result {
                    Ok(()) => {
                        for p in pins_of {
                            self.set(p, PinState::Downloading, None).await?;
                        }
                    }
                    Err(message) => {
                        for p in pins_of {
                            tracing::warn!(track_id = p.track_id, error = %message, "pinned download failed to start");
                            self.set(p, PinState::Failed, Some(&message)).await?;
                        }
                    }
                }
            }
        }

        self.publish_progress(&files).await
    }

    /// Файл не двигается дольше `stall_timeout` (нет `file_progress` — тоже «не двигается»).
    fn is_stalled(&mut self, files: &Arc<dyn FileProvider>, p: &PinWork) -> bool {
        let (Some(torrent_id), Some(file_index), Some(hash)) =
            (p.torrent_id, p.file_index, p.info_hash.as_deref())
        else {
            return false;
        };
        let key = (torrent_id, file_index);
        let progress = InfoHash::parse(hash).ok().and_then(|h| {
            // Фейки и движок могут паниковать/молчать — для менеджера это «нет прогресса».
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                files.file_progress(&TorrentHandleId(h), file_index as usize)
            }))
            .ok()
            .flatten()
        });
        let now = Instant::now();
        let bytes = progress.map(|p| p.bytes_done);
        if progress.is_some_and(|p| p.finished) {
            // Дозавершит Watcher.
            self.stalls.remove(&key);
            return false;
        }
        match (self.stalls.get(&key).copied(), bytes) {
            (Some((last, _)), Some(b)) if b != last => {
                self.stalls.insert(key, (b, now));
                false
            }
            (Some((_, since)), _) => since.elapsed() >= self.cfg.stall_timeout,
            (None, b) => {
                self.stalls.insert(key, (b.unwrap_or(0), now));
                self.cfg.stall_timeout.is_zero() && b.is_none()
            }
        }
    }

    /// Зависший файл: следующий источник трека, а если его нет — `failed("stalled")`.
    async fn handle_stall(&mut self, p: &PinWork) -> sqlx::Result<()> {
        if let Some(key) = p.torrent_id.zip(p.file_index) {
            self.stalls.remove(&key);
        }
        let source: Option<TrackSource> = match p.source_id {
            Some(id) => track_sources::get(&self.state.db, id).await?,
            None => None,
        };
        if let Some(source) = &source {
            let tried = self.tried.entry(p.track_id).or_default();
            tried.push(source.id);
            if crate::stream::switch_to_next_source(&self.state, source, tried).await {
                // `set_primary` вернул закрепление в `queued`; старый файл больше не нужен.
                self.state.events.publish_acquisition_changed(p.album_id);
                crate::sources::release_unneeded(&self.state, source).await;
                return Ok(());
            }
        }
        tracing::warn!(
            track_id = p.track_id,
            "pinned download stalled, no other source"
        );
        // Авто-повтор начнёт с чистого листа.
        self.tried.remove(&p.track_id);
        self.set(p, PinState::Failed, Some("stalled")).await
    }

    /// Запрашивает у движка все файлы группы одним `ensure_files` и создаёт строки `downloads`.
    /// `Err(message)` — причина для `pinned_tracks.error`.
    async fn start_group(
        &self,
        files: &Arc<dyn FileProvider>,
        torrent_id: i64,
        pins_of: &[&PinWork],
    ) -> Result<(), String> {
        let db = &self.state.db;
        let torrent = torrents::get(db, torrent_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("torrent not found")?;
        let tref = torrent_file::torrent_ref(db, &torrent)
            .await
            .map_err(|e| e.to_string())?;
        let mut indexes: Vec<usize> = pins_of
            .iter()
            .filter_map(|p| p.file_index)
            .map(|i| i as usize)
            .collect();
        indexes.sort_unstable();
        indexes.dedup();
        // У движка свой таймаут метаданных; этот — запас на случай зависания самого вызова.
        let guard = Duration::from_secs(
            u64::from(self.state.settings.get().performance.metadata_timeout_secs) + 60,
        );
        let handle = tokio::time::timeout(guard, files.ensure_files(&tref, &indexes))
            .await
            .map_err(|_| "timed out starting the torrent".to_string())?
            .map_err(|e| match e {
                EngineError::Storage(m) => format!("storage: {m}"),
                other => other.to_string(),
            })?;
        torrent_file::remember_engine_file(db, files.as_ref(), &handle, &torrent).await;
        for p in pins_of {
            let (Some(file_index), size) = (p.file_index, p.size_bytes) else {
                continue;
            };
            let exists = downloads::get(db, torrent_id, file_index)
                .await
                .map_err(|e| e.to_string())?
                .is_some();
            if exists {
                continue;
            }
            let path = files
                .file_path(&handle, file_index as usize)
                .ok_or("file path is unknown")?;
            let total = files
                .file_progress(&handle, file_index as usize)
                .map(|p| p.bytes_total as i64)
                .or(size)
                .unwrap_or(0);
            downloads::upsert(
                db,
                &NewDownload {
                    torrent_id,
                    file_index,
                    local_path: path.to_string_lossy().into_owned(),
                    bytes_total: total,
                    bytes_done: 0,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        if let Err(e) = files.resume_torrent(&handle).await {
            tracing::debug!(torrent_id, error = %e, "resume_torrent after ensure_files failed");
        }
        Ok(())
    }

    /// На паузе: торренты, которые качаются только ради закреплений, ставятся на паузу.
    /// Торрент со стримящимся файлом или с файлами, не нужными закреплениям, не трогаем.
    async fn pause_pinned(&mut self, files: &Arc<dyn FileProvider>, open: &[PinWork]) {
        let active = match downloads::list_active_with_hash(&self.state.db).await {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(error = %e, "cannot list downloads to pause");
                return;
            }
        };
        let pinned_files: HashSet<FileKey> = open
            .iter()
            .filter(|p| p.state != PinState::WaitingSource)
            .filter_map(|p| p.torrent_id.zip(p.file_index))
            .collect();
        let hashes: HashMap<i64, String> = open
            .iter()
            .filter_map(|p| Some((p.torrent_id?, p.info_hash.clone()?)))
            .collect();
        for (torrent_id, hash) in hashes {
            if self.paused_torrents.contains(&torrent_id) {
                continue;
            }
            let of_torrent = active.iter().filter(|d| d.torrent_id == torrent_id);
            // Паузим то, что реально качается (есть незавершённые файлы), — в том числе после рестарта,
            // когда движок сам поднял торренты из сессии, а закрепления ещё `queued`.
            if of_torrent.clone().next().is_none() {
                continue;
            }
            let only_pins = of_torrent.clone().all(|d| {
                pinned_files.contains(&(d.torrent_id, d.file_index))
                    && !self.state.activity.is_protected(d.torrent_id, d.file_index)
            });
            if !only_pins {
                continue;
            }
            let Ok(h) = InfoHash::parse(&hash) else {
                continue;
            };
            match files.pause_torrent(&TorrentHandleId(h)).await {
                Ok(()) => {
                    self.paused_torrents.insert(torrent_id);
                }
                // Торрента нет в движке — паузить нечего.
                Err(EngineError::NotFound) => {}
                Err(e) => tracing::warn!(torrent_id, error = %e, "cannot pause torrent"),
            }
        }
    }

    async fn resume_paused(&mut self, files: &Arc<dyn FileProvider>) {
        for torrent_id in std::mem::take(&mut self.paused_torrents) {
            let hash = match torrents::get(&self.state.db, torrent_id).await {
                Ok(Some(t)) => t.info_hash,
                _ => continue,
            };
            let Ok(h) = InfoHash::parse(&hash) else {
                continue;
            };
            if let Err(e) = files.resume_torrent(&TorrentHandleId(h)).await {
                if !matches!(e, EngineError::NotFound) {
                    tracing::warn!(torrent_id, error = %e, "cannot resume torrent");
                }
            }
        }
    }

    /// `download.progress` по альбомам с идущими закреплёнными загрузками и обновление `Live`.
    async fn publish_progress(&mut self, files: &Arc<dyn FileProvider>) -> sqlx::Result<()> {
        let open = pins::list_open(&self.state.db).await?;
        // Файл и торрент учитываются один раз, даже если на него ссылаются несколько треков (CUE).
        struct Agg {
            files: HashMap<FileKey, (u64, u64)>,
            torrents: HashMap<i64, (u64, u32)>,
        }
        let mut per_album: HashMap<i64, Agg> = HashMap::new();
        for p in open.iter().filter(|p| p.state == PinState::Downloading) {
            let (Some(torrent_id), Some(file_index), Some(hash)) =
                (p.torrent_id, p.file_index, p.info_hash.as_deref())
            else {
                continue;
            };
            let Ok(h) = InfoHash::parse(hash) else {
                continue;
            };
            let progress = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                files.file_progress(&TorrentHandleId(h), file_index as usize)
            }))
            .ok()
            .flatten();
            let agg = per_album.entry(p.album_id).or_insert_with(|| Agg {
                files: HashMap::new(),
                torrents: HashMap::new(),
            });
            if let Some(pr) = progress {
                agg.files
                    .insert((torrent_id, file_index), (pr.bytes_done, pr.bytes_total));
                agg.torrents
                    .insert(torrent_id, (pr.down_speed_bps, pr.peers));
            }
        }
        let album_ids: Vec<i64> = per_album.keys().copied().collect();
        let completed: HashMap<i64, u64> =
            nimbus_db::repo::downloads::completed_bytes_by_album(&self.state.db, &album_ids)
                .await?
                .into_iter()
                .map(|(a, b)| (a, b.max(0) as u64))
                .collect();
        let mut live = HashMap::new();
        let emit = self
            .last_progress
            .is_none_or(|t| t.elapsed() >= self.cfg.progress_every);
        for (album_id, agg) in &per_album {
            let (bytes_done, bytes_total) = agg
                .files
                .values()
                .fold((0, 0), |(d, t), (fd, ft)| (d + fd, t + ft));
            // Уже докачанные треки альбома входят и в «скачано», и в «всего».
            let finished = completed.get(album_id).copied().unwrap_or(0);
            let (bytes_done, bytes_total) = (bytes_done + finished, bytes_total + finished);
            let (down_bps, peers) = agg
                .torrents
                .values()
                .fold((0, 0), |(b, p), (tb, tp)| (b + tb, p + tp));
            live.insert(*album_id, Live { down_bps, peers });
            if emit {
                self.state.events.publish(Event::DownloadProgress {
                    album_id: *album_id,
                    bytes_done,
                    bytes_total,
                    down_bps,
                    peers,
                });
            }
        }
        if emit && !per_album.is_empty() {
            self.last_progress = Some(Instant::now());
        }
        self.state.downloads.replace_live(live);
        Ok(())
    }
}

/// Запускает менеджер под супервизором; завершается по `cancel`. Задачу ждёт вызывающий.
pub fn spawn_download_manager(
    state: AppState,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    spawn_download_manager_with(state, cancel, ManagerConfig::default())
}

/// Супервизор: тик раз в `cfg.tick`, по `Notify` и по `track.status → found`. Паника в тике
/// логируется (`error`), состояние менеджера создаётся заново, цикл продолжается; ошибка БД —
/// предупреждение. Тик не прерывается отменой: он состоит из коротких операций.
pub fn spawn_download_manager_with(
    state: AppState,
    cancel: CancellationToken,
    cfg: ManagerConfig,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match DownloadManager::startup(&state).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(
                pins = n,
                "unfinished pinned downloads put back in the queue"
            ),
            Err(e) => tracing::warn!(error = %e, "cannot requeue pinned downloads at startup"),
        }
        let mut manager = DownloadManager::new(state.clone(), cfg.clone());
        let mut events = state.events.subscribe();
        let mut interval = tokio::time::interval(cfg.tick);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                _ = interval.tick() => {}
                () = state.downloads.notify.notified() => {}
                ev = events.recv() => match ev {
                    Ok(Event::TrackStatus { status: TrackStatus::Found, .. })
                    | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        events = state.events.subscribe();
                        continue;
                    }
                },
            }
            match std::panic::AssertUnwindSafe(manager.tick())
                .catch_unwind()
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::warn!(error = %e, "download manager tick failed"),
                Err(panic) => {
                    let msg = panic
                        .downcast_ref::<&str>()
                        .map(|s| (*s).to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_default();
                    tracing::error!(panic = %msg, "download manager panicked, restarting");
                    tokio::select! {
                        () = cancel.cancelled() => return,
                        () = tokio::time::sleep(cfg.restart_pause) => {}
                    }
                    manager = DownloadManager::new(state.clone(), cfg.clone());
                    interval.reset();
                }
            }
        }
    })
}

// ------------------------------------------------------------ снятие закрепления

/// Снимает закрепления с треков `track_ids` (уже удалены из `pinned_tracks`) и разбирается с файлами.
///
/// * `delete_files` — файлы, которые не нужны другому закреплённому треку и не стримятся, удаляются
///   с диска и из движка, треки `ready → found`;
/// * иначе завершённые файлы остаются (вытеснение снова может их удалить), а недокачанные
///   — отменяются вместе с частичными данными: закрепление было единственной причиной их качать.
pub async fn release_files(
    state: &AppState,
    track_ids: &[i64],
    delete_files: bool,
) -> Result<(), sqlx::Error> {
    for (torrent_id, file_index) in pins::primary_files_of_tracks(&state.db, track_ids).await? {
        if pins::file_is_pinned(&state.db, torrent_id, file_index).await?
            || state.activity.is_protected(torrent_id, file_index)
        {
            continue;
        }
        let completed = downloads::get(&state.db, torrent_id, file_index)
            .await?
            .is_some_and(|d| d.completed_at.is_some());
        if delete_files || !completed {
            delete_file(state, torrent_id, file_index).await?;
        }
    }
    Ok(())
}

/// Удаляет файл из движка и с диска, строку `downloads`; `ready`-треки файла становятся `found`.
async fn delete_file(
    state: &AppState,
    torrent_id: i64,
    file_index: i32,
) -> Result<(), sqlx::Error> {
    let download = downloads::get(&state.db, torrent_id, file_index).await?;
    if let (Some(files), Some(t)) = (
        state.files.as_ref(),
        torrents::get(&state.db, torrent_id).await?,
    ) {
        if let Ok(hash) = InfoHash::parse(&t.info_hash) {
            if let Err(e) = files
                .release_file(&TorrentHandleId(hash), file_index as usize, true)
                .await
            {
                tracing::debug!(torrent_id, error = %e, "release_file failed");
            }
        }
    }
    if let Some(d) = &download {
        match std::fs::remove_file(&d.local_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                // Файл остаётся на месте — строку `downloads` не трогаем, чтобы учёт места не врал.
                tracing::warn!(path = %d.local_path, error = %e, "cannot delete downloaded file");
                return Ok(());
            }
        }
        nimbus_worker::cache::prune_empty_dirs(std::path::Path::new(&d.local_path));
        downloads::delete(&state.db, torrent_id, file_index).await?;
    }
    for t in
        track_sources::tracks_with_primary(&state.db, torrent_id, file_index, TrackStatus::Ready)
            .await?
    {
        set_track_status_and_publish(&state.db, &state.events, t.id, TrackStatus::Found, None)
            .await?;
    }
    Ok(())
}
