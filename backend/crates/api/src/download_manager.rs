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
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_core::model::{InfoHash, NewDownload, PinState, TrackSource, TrackStatus};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use nimbus_db::repo::pins::{self, PinWork};
use nimbus_db::repo::{acquisition, album_torrents, downloads, torrents, track_sources};
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
    /// Сколько файл может не двигаться при живых пирах, прежде чем источник будет заменён.
    pub stall_timeout: Duration,
    /// То же, когда пиров нет вовсе (или движок не знает файла): ждать нечего, меняем источник раньше.
    pub stall_timeout_no_peers: Duration,
    /// Паузы перед повтором после временных сбоев (хранилище, движок): ступени по порядку,
    /// последняя повторяется без ограничения числа попыток.
    pub transient_pauses: Vec<Duration>,
    /// Паузы между циклами «источники не отдают данные» (`stalled`); когда они исчерпаны,
    /// закрепление становится `dead` и повторяется раз в `dead_pause`.
    pub stalled_pauses: Vec<Duration>,
    /// Пауза между повторами `dead` и отказа без запасных источников (счётчик `retries` не растёт).
    pub dead_pause: Duration,
    /// Как часто можно запрашивать новый поиск раздач для альбома с зависшими закреплениями.
    pub discover_interval: Duration,
    /// Пауза перед перезапуском менеджера после паники в тике.
    pub restart_pause: Duration,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(1),
            progress_every: Duration::from_secs(1),
            stall_timeout: Duration::from_secs(600),
            stall_timeout_no_peers: Duration::from_secs(180),
            transient_pauses: [60, 300, 900, 3600].map(Duration::from_secs).to_vec(),
            stalled_pauses: [1, 3, 6, 12, 24, 24]
                .map(|h| Duration::from_secs(h * 3600))
                .to_vec(),
            dead_pause: Duration::from_secs(24 * 3600),
            discover_interval: Duration::from_secs(6 * 3600),
            restart_pause: Duration::from_secs(1),
        }
    }
}

/// Файл торрента: `(torrent_id, file_index)`.
type FileKey = (i64, i32);

/// Класс неудачи запуска или загрузки: от него зависит, как и когда закрепление повторится.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Временный сбой (хранилище, движок, таймаут запуска): повтор по лесенке пауз без ограничения.
    Transient,
    /// Источник не отдаёт данные (нет метаданных, зависание): сначала другой источник, затем цикл пауз.
    NoPeers,
    /// Повтор бессмыслен (плохая ссылка, неверный индекс файла, раздачи нет в БД).
    Permanent,
    /// Сбой БД самого менеджера: ничего не фиксируется, закрепление остаётся в очереди до следующего тика.
    Db,
}

/// Класс неудачи движка.
pub fn classify(e: &EngineError) -> Failure {
    match e {
        EngineError::MetadataTimeout => Failure::NoPeers,
        EngineError::InvalidMagnet(_) | EngineError::InvalidFileIndex(_) => Failure::Permanent,
        EngineError::NotFound
        | EngineError::Io(_)
        | EngineError::Storage(_)
        | EngineError::Internal(_) => Failure::Transient,
    }
}

/// Пауза ступени `step`; за пределами списка — последняя.
fn pause_at(pauses: &[Duration], step: usize) -> Duration {
    pauses
        .get(step)
        .or(pauses.last())
        .copied()
        .unwrap_or_default()
}

fn db_failure(e: impl std::fmt::Display) -> (Failure, String) {
    (Failure::Db, e.to_string())
}

pub struct DownloadManager {
    state: AppState,
    cfg: ManagerConfig,
    /// Последний замеченный прогресс файла и когда он менялся (для обнаружения зависания).
    stalls: HashMap<FileKey, (u64, Instant)>,
    /// Источники трека, на которых загрузка уже зависала: по кругу между ними не ходим.
    tried: HashMap<i64, Vec<i64>>,
    /// Файлы, у которых после зависания уже был перезапуск того же источника.
    restarted: HashSet<FileKey>,
    /// Ступень лесенки пауз после временных сбоев (по треку); сбрасывается успехом и рестартом.
    transient_steps: HashMap<i64, usize>,
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
            restarted: HashSet::new(),
            transient_steps: HashMap::new(),
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
        for track_id in pins::retry_failed(db).await? {
            tracing::info!(track_id, "pinned download retried automatically");
        }

        let open = pins::list_open(db).await?;
        // Уборка: состояние снятых закреплений не копится.
        let open_files: HashSet<FileKey> = open
            .iter()
            .filter_map(|p| p.torrent_id.zip(p.file_index))
            .collect();
        let open_tracks: HashSet<i64> = open.iter().map(|p| p.track_id).collect();
        self.stalls.retain(|k, _| open_files.contains(k));
        self.restarted.retain(|k| open_files.contains(k));
        self.tried.retain(|t, _| open_tracks.contains(t));
        self.transient_steps.retain(|t, _| open_tracks.contains(t));
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
                self.restarted.remove(&key);
                self.tried.remove(&p.track_id);
                self.transient_steps.remove(&p.track_id);
                if p.retries > 0 {
                    self.reset_retries(p.track_id).await;
                }
                continue;
            }
            match p.state {
                // Нет строки `downloads` — `found → ready` не наступит никогда: запускаем заново.
                PinState::Downloading if !existing.contains_key(&key) => queued.push((p, key)),
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
            let Some(torrent_lost) = self.is_stalled(&files, p).await else {
                still.push(p);
                continue;
            };
            let (Some(torrent_id), Some(file_index)) = (p.torrent_id, p.file_index) else {
                continue;
            };
            if torrent_lost && self.restarted.insert((torrent_id, file_index)) {
                // Движок потерял торрент: один перезапуск того же источника; отсчёт зависания
                // начнётся заново. Живой торрент без данных — сразу другой источник.
                self.stalls.remove(&(torrent_id, file_index));
                match self.start_group(&files, torrent_id, &[p]).await {
                    Ok(()) => still.push(p),
                    Err((failure, message)) => {
                        self.apply_failure(&[p], failure, &message).await?;
                        active.remove(&torrent_id);
                    }
                }
            } else {
                self.give_up_source(p).await?;
                active.remove(&torrent_id);
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
                            self.transient_steps.remove(&p.track_id);
                            self.set(p, PinState::Downloading, None).await?;
                        }
                    }
                    Err((failure, message)) => {
                        self.apply_failure(pins_of, failure, &message).await?;
                    }
                }
            }
        }

        self.publish_progress(&files).await
    }

    /// Файл не двигается дольше таймаута: `stall_timeout`, если есть пиры, иначе (пиров нет или движок
    /// не знает файла) `stall_timeout_no_peers`. `Some(true)` — зависание, и движок потерял торрент
    /// (нет `file_progress`); `Some(false)` — торрент жив, данных нет; `None` — всё в порядке.
    /// Любое движение байтов обнуляет счётчик повторов закрепления: медленная, но живая раздача
    /// не исчерпывает бюджет.
    async fn is_stalled(&mut self, files: &Arc<dyn FileProvider>, p: &PinWork) -> Option<bool> {
        let (Some(torrent_id), Some(file_index), Some(hash)) =
            (p.torrent_id, p.file_index, p.info_hash.as_deref())
        else {
            return None;
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
            return None;
        }
        let timeout = if progress.is_some_and(|p| p.peers > 0) {
            self.cfg.stall_timeout
        } else {
            self.cfg.stall_timeout_no_peers
        };
        let stalled = match (self.stalls.get(&key).copied(), bytes) {
            (Some((last, _)), Some(b)) if b != last => {
                self.stalls.insert(key, (b, now));
                self.restarted.remove(&key);
                if p.retries > 0 {
                    self.reset_retries(p.track_id).await;
                }
                false
            }
            (Some((_, since)), _) => since.elapsed() >= timeout,
            (None, b) => {
                self.stalls.insert(key, (b.unwrap_or(0), now));
                timeout.is_zero() && b.is_none()
            }
        };
        stalled.then_some(progress.is_none())
    }

    async fn reset_retries(&self, track_id: i64) {
        if let Err(e) = pins::reset_retries(&self.state.db, track_id).await {
            tracing::warn!(track_id, error = %e, "cannot reset pin retries");
        }
    }

    /// Применяет неудачу к закреплениям группы по её классу (см. [`Failure`]).
    async fn apply_failure(
        &mut self,
        pins_of: &[&PinWork],
        failure: Failure,
        message: &str,
    ) -> sqlx::Result<()> {
        for p in pins_of {
            tracing::warn!(track_id = p.track_id, error = %message, ?failure, "pinned download failed");
            match failure {
                Failure::Db => {}
                Failure::Transient => {
                    let step = self.transient_steps.entry(p.track_id).or_insert(0);
                    let pause = pause_at(&self.cfg.transient_pauses, *step);
                    *step += 1;
                    self.fail(p, message, Some(pause), false).await?;
                }
                Failure::Permanent => {
                    // Плохая раздача (ссылка, индекс файла): сначала другой источник трека.
                    if !self.switch_source(p).await? {
                        self.tried.remove(&p.track_id);
                        self.fail(p, message, Some(self.cfg.dead_pause), false)
                            .await?;
                        self.request_new_sources(p.album_id).await;
                    }
                }
                Failure::NoPeers => self.give_up_source(p).await?,
            }
        }
        Ok(())
    }

    /// `failed` с расписанием: `pause = None` — без автоматического повтора (в боевом коде не используется:
    /// закрепление без расписания — нарушение инварианта I8).
    async fn fail(
        &self,
        p: &PinWork,
        error: &str,
        pause: Option<Duration>,
        count: bool,
    ) -> sqlx::Result<()> {
        let next = pause.map(|d| {
            chrono::Utc::now() + chrono::Duration::from_std(d).unwrap_or(chrono::Duration::days(1))
        });
        pins::fail(&self.state.db, p.track_id, error, next, count).await?;
        self.state.events.publish_acquisition_changed(p.album_id);
        Ok(())
    }

    /// Помечает текущий источник опробованным и переключает primary трека на следующий (в том числе
    /// CUE-долю — для загрузки на сервер это допустимо). `false` — переключаться некуда.
    async fn switch_source(&mut self, p: &PinWork) -> sqlx::Result<bool> {
        if let Some(key) = p.torrent_id.zip(p.file_index) {
            self.stalls.remove(&key);
            self.restarted.remove(&key);
        }
        let source: Option<TrackSource> = match p.source_id {
            Some(id) => track_sources::get(&self.state.db, id).await?,
            None => None,
        };
        let Some(source) = source else {
            return Ok(false);
        };
        let tried = self.tried.entry(p.track_id).or_default();
        tried.push(source.id);
        if !crate::stream::switch_to_next_source(&self.state, &source, tried, true).await {
            return Ok(false);
        }
        // `set_primary` вернул закрепление в `queued` и обнулил `retries`, а цикл «нет сидов»
        // должен копиться между сменами источника.
        if p.retries > 0 {
            pins::set_retries(&self.state.db, p.track_id, p.retries).await?;
        }
        self.state.events.publish_acquisition_changed(p.album_id);
        crate::sources::release_unneeded(&self.state, &source).await;
        Ok(true)
    }

    /// Источник не отдаёт данные: следующий источник трека, а если его нет — `failed("stalled")`
    /// с растущей паузой, после исчерпания пауз — `dead` с повтором раз в `dead_pause`; параллельно
    /// просим поиск новых раздач.
    async fn give_up_source(&mut self, p: &PinWork) -> sqlx::Result<()> {
        if self.switch_source(p).await? {
            return Ok(());
        }
        tracing::warn!(
            track_id = p.track_id,
            "pinned download stalled, no other source"
        );
        // Следующий цикл начнёт с чистого листа.
        self.tried.remove(&p.track_id);
        let cycle = usize::try_from(p.retries).unwrap_or_default();
        if cycle >= self.cfg.stalled_pauses.len() {
            // Счётчик не растёт: повторов может быть сколько угодно.
            self.fail(p, "dead", Some(self.cfg.dead_pause), false)
                .await?;
        } else {
            let pause = pause_at(&self.cfg.stalled_pauses, cycle);
            self.fail(p, "stalled", Some(pause), true).await?;
        }
        self.request_new_sources(p.album_id).await;
        Ok(())
    }

    /// Ставит поиск раздач для альбома, если последний поиск был давно (дубликаты задач схлопывает очередь).
    /// Раздачи альбома, которые не удалось проверить (`dead`/`timeout`/`error`: раздающий был офлайн),
    /// возвращаются на проверку в той же транзакции, что и поиск.
    async fn request_new_sources(&self, album_id: i64) {
        let db = &self.state.db;
        match acquisition::searched_within(db, album_id, self.cfg.discover_interval).await {
            Ok(true) => {}
            Ok(false) => {
                if let Err(e) = self.queue_discover(album_id).await {
                    tracing::warn!(album_id, error = %e, "cannot queue the search for new sources");
                }
            }
            Err(e) => tracing::warn!(album_id, error = %e, "cannot check the last album search"),
        }
    }

    async fn queue_discover(&self, album_id: i64) -> sqlx::Result<()> {
        let mut tx = self.state.db.begin().await?;
        album_torrents::reset_dead(&mut *tx, album_id).await?;
        jobs::enqueue(
            &mut *tx,
            &Job::DiscoverAlbum { album_id },
            EnqueueOpts::priority(PRIORITY_BACKGROUND),
        )
        .await?;
        tx.commit().await
    }

    /// Запрашивает у движка все файлы группы одним `ensure_files` и создаёт строки `downloads`.
    /// `Err((класс, сообщение))` — сообщение пойдёт в `pinned_tracks.error`.
    async fn start_group(
        &self,
        files: &Arc<dyn FileProvider>,
        torrent_id: i64,
        pins_of: &[&PinWork],
    ) -> Result<(), (Failure, String)> {
        let db = &self.state.db;
        let torrent = torrents::get(db, torrent_id)
            .await
            .map_err(db_failure)?
            .ok_or_else(|| (Failure::Permanent, "torrent not found".to_string()))?;
        let tref = torrent_file::torrent_ref(db, &torrent)
            .await
            .map_err(db_failure)?;
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
            .map_err(|_| {
                (
                    Failure::Transient,
                    "timed out starting the torrent".to_string(),
                )
            })?
            .map_err(|e| {
                let failure = classify(&e);
                let message = match e {
                    EngineError::Storage(m) => format!("storage: {m}"),
                    other => other.to_string(),
                };
                (failure, message)
            })?;
        torrent_file::remember_engine_file(db, files.as_ref(), &handle, &torrent).await;
        for p in pins_of {
            let (Some(file_index), size) = (p.file_index, p.size_bytes) else {
                continue;
            };
            let exists = downloads::get(db, torrent_id, file_index)
                .await
                .map_err(db_failure)?
                .is_some();
            if exists {
                continue;
            }
            let path = files
                .file_path(&handle, file_index as usize)
                .ok_or_else(|| (Failure::Transient, "file path is unknown".to_string()))?;
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
            .map_err(db_failure)?;
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

/// Супервизор: тик раз в `cfg.tick`, по `Notify`, по `track.status → found` и по `acquisition.changed`. Паника в тике
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
                    // Новый источник мог оживить закрепление (verify_torrent, B04).
                    | Ok(Event::AcquisitionChanged { .. })
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
pub(crate) async fn delete_file(
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
