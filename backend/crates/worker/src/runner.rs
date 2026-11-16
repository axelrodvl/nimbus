use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use futures::FutureExt;
use nimbus_core::events::EventBus;
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_db::repo::jobs::{self, JobRow};
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::{MetadataFetcher, TorrentEngine};
use nimbus_trackers::ProviderRegistry;
use sqlx::postgres::PgListener;
use sqlx::PgPool;
use tokio::sync::Notify;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

/// Контекст, доступный обработчикам (следующие шаги добавят сюда trackers, torrent).
#[derive(Clone)]
pub struct JobCtx {
    pub db: PgPool,
    pub events: EventBus,
    /// Клиент MusicBrainz с интерактивным приоритетом; фоновым задачам нужен `mb.background()`.
    pub mb: MbClient,
    /// Провайдеры торрентов (TPB, Torznab, RuTracker).
    pub providers: Arc<ProviderRegistry>,
    /// Торрент-движок; в тестах без торрентов может отсутствовать (`ctx.engine()` вернёт `Fatal`).
    pub engine: Option<Arc<TorrentEngine>>,
    /// Источник метаданных торрентов (по умолчанию — движок; в тестах — фейк).
    pub fetcher: Option<Arc<dyn MetadataFetcher>>,
    /// Доступ к файлам торрентов (CUE-файлы; по умолчанию — движок, в тестах — фейк).
    pub files: Option<Arc<dyn nimbus_torrent::FileProvider>>,
    /// Настройки приложения (редактируются из UI).
    pub settings: nimbus_db::settings::SettingsStore,
    /// Активные стримы и недавний prefetch: эти файлы вытеснение кэша не трогает.
    pub activity: nimbus_core::activity::Activity,
    /// Номер текущей попытки (с 1) и лимит попыток задачи; выставляются раннером перед вызовом.
    pub attempt: i32,
    pub max_attempts: i32,
    /// Отмена: срабатывает при остановке пула. Обработчики, ждущие сеть, обязаны завершаться
    /// по ней (`tokio::select!` с `ctx.cancel.cancelled()`) и возвращать [`JobError::Cancelled`].
    pub cancel: CancellationToken,
    /// Приоритет выполняемой задачи; порождаемые ею задачи наследуют его (выставляет раннер).
    pub priority: i16,
    /// Блокировки по раздаче: метаданные одной раздачи запрашивает одна задача за раз (`verify_torrent`).
    pub meta_locks: Arc<crate::keyed_locks::KeyedLocks>,
    /// Паузы по раздаче после таймаута метаданных: пока пауза расписания не прошла, ни одна задача
    /// не делает новый запрос (у дискографии задач больше, чем воркеров проверки).
    pub meta_cooldowns: Arc<crate::keyed_locks::Cooldowns>,
}

impl JobCtx {
    pub fn new(
        db: PgPool,
        events: EventBus,
        mb: MbClient,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            settings: nimbus_db::settings::SettingsStore::new(
                db.clone(),
                nimbus_core::Settings::default(),
            ),
            activity: nimbus_core::activity::Activity::default(),
            db,
            events,
            mb,
            providers,
            engine: None,
            fetcher: None,
            files: None,
            attempt: 1,
            max_attempts: 1,
            cancel: CancellationToken::new(),
            priority: nimbus_core::jobs::PRIORITY_NORMAL,
            meta_locks: Arc::default(),
            meta_cooldowns: Arc::default(),
        }
    }

    pub fn with_engine(mut self, engine: Arc<TorrentEngine>) -> Self {
        self.fetcher = Some(engine.clone());
        self.files = Some(engine.clone());
        self.engine = Some(engine);
        self
    }

    pub fn with_fetcher(mut self, fetcher: Arc<dyn MetadataFetcher>) -> Self {
        self.fetcher = Some(fetcher);
        self
    }

    pub fn with_settings(mut self, settings: nimbus_db::settings::SettingsStore) -> Self {
        self.settings = settings;
        self
    }

    pub fn with_activity(mut self, activity: nimbus_core::activity::Activity) -> Self {
        self.activity = activity;
        self
    }

    pub fn with_files(mut self, files: Arc<dyn nimbus_torrent::FileProvider>) -> Self {
        self.files = Some(files);
        self
    }

    pub fn files(&self) -> Result<&Arc<dyn nimbus_torrent::FileProvider>, JobError> {
        self.files
            .as_ref()
            .ok_or_else(|| JobError::Fatal("file provider is not configured".into()))
    }

    pub fn fetcher(&self) -> Result<&Arc<dyn MetadataFetcher>, JobError> {
        self.fetcher
            .as_ref()
            .ok_or_else(|| JobError::Fatal("metadata fetcher is not configured".into()))
    }

    pub fn engine(&self) -> Result<&Arc<TorrentEngine>, JobError> {
        self.engine
            .as_ref()
            .ok_or_else(|| JobError::Fatal("torrent engine is not configured".into()))
    }

    /// Выполняет ожидание (сеть, поиск) отменяемо: при остановке пула возвращает [`JobError::Cancelled`].
    pub async fn run<T>(&self, fut: impl std::future::Future<Output = T>) -> Result<T, JobError> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(JobError::Cancelled),
            v = fut => Ok(v),
        }
    }

    /// Последняя ли это попытка (после неё задача получит статус `failed`).
    pub fn is_last_attempt(&self) -> bool {
        self.attempt >= self.max_attempts
    }
}

/// Сколько (с момента первого откладывания, `jobs.deferred_since`) живёт задача, которую раз за разом
/// откладывают «без вины» (`JobError::Defer`), прежде чем её признают неудавшейся: дальше нужен ручной или плановый повтор, а не бесконечное ожидание.
pub const DEFER_MAX_AGE: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    /// Временная ошибка: повторить через `after`.
    #[error("retry in {after:?}: {reason}")]
    Retry { after: Duration, reason: String },
    /// Отложить без траты попытки: причина не в задаче (провайдер недоступен, предохранитель разомкнут).
    /// Задача, откладываемая дольше [`DEFER_MAX_AGE`], после такого ответа становится `failed`.
    #[error("deferred for {after:?}: {reason}")]
    Defer { after: Duration, reason: String },
    /// Не повторять.
    #[error("fatal: {0}")]
    Fatal(String),
    /// Неожиданная ошибка: повтор с экспоненциальным backoff по умолчанию.
    #[error("unexpected: {0}")]
    Unexpected(String),
    /// Обработчик прерван остановкой пула: задача возвращается в очередь без траты попытки.
    #[error("cancelled")]
    Cancelled,
}

impl From<anyhow::Error> for JobError {
    fn from(e: anyhow::Error) -> Self {
        JobError::Unexpected(format!("{e:#}"))
    }
}

impl From<sqlx::Error> for JobError {
    fn from(e: sqlx::Error) -> Self {
        JobError::Unexpected(e.to_string())
    }
}

#[async_trait]
pub trait JobHandler: Send + Sync {
    fn kinds(&self) -> &'static [&'static str];
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError>;

    /// Вызывается после того, как неудавшаяся попытка записана и задача вернулась в `queued`
    /// (повтор запланирован). Нужен, чтобы UI увидел изменившийся статус уже по актуальным данным.
    async fn on_retry(&self, _job: &Job, _ctx: &JobCtx, _reason: &str) {}

    /// Вызывается один раз, когда задача окончательно стала `failed`. Должен привести данные
    /// в согласованное состояние (ничего не должно навсегда остаться «в процессе»).
    /// `fatal` — причина окончательная (`JobError::Fatal`), а не исчерпание попыток на временных
    /// ошибках, потере воркера или откладываниях: во втором случае повтор позже может помочь.
    async fn on_exhausted(
        &self,
        _job: &Job,
        _ctx: &JobCtx,
        _reason: &str,
        _fatal: bool,
    ) -> Result<(), JobError> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Базовая задержка backoff: `base * 2^(attempts-1)`.
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Как часто опрашивать очередь, если нет NOTIFY.
    pub poll_interval: Duration,
    /// Как часто раннер отмечает, что задача жива (`jobs.heartbeat_at`).
    pub heartbeat_interval: Duration,
    /// Сколько без heartbeat задача `running` считается зависшей (воркер умер).
    pub stale_after: Duration,
    pub maintenance_interval: Duration,
    pub done_retention: Duration,
    /// Сколько трек может висеть в `adding` без активного поиска, прежде чем обслуживание
    /// финализирует его альбом (см. `verify::finalize_stuck_albums`).
    pub stuck_grace: Duration,
    /// Сколько хранятся надгробия синхронизации (шаг 34): клиент, не заходивший дольше, берёт снимок заново.
    pub tombstone_retention: Duration,
    pub shutdown_timeout: Duration,
    /// Как часто ставить задачу вытеснения кэша (`None` — не ставить).
    pub evict_interval: Option<Duration>,
    /// Как часто ставить `RetryMissing` (автоповтор поиска, шаг 32), если включён `search.auto_retry`
    /// (`None` — не ставить).
    pub retry_missing_interval: Option<Duration>,
    /// Пауза перед перезапуском цикла воркера, обслуживания или слушателя после паники.
    pub restart_pause: Duration,
    /// Паузы перед оживлением упавшей задачи по числу прошлых оживлений (последняя повторяется).
    pub revive_delays: Vec<Duration>,
    /// Сколько хранятся окончательно провалённые и вытесненные `failed`-задачи.
    pub failed_retention: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_secs(30),
            backoff_max: Duration::from_secs(30 * 60),
            poll_interval: Duration::from_secs(5),
            heartbeat_interval: Duration::from_secs(15),
            stale_after: Duration::from_secs(90),
            maintenance_interval: Duration::from_secs(60),
            done_retention: Duration::from_secs(7 * 24 * 3600),
            stuck_grace: Duration::from_secs(10 * 60),
            tombstone_retention: nimbus_db::repo::sync::TOMBSTONE_RETENTION,
            shutdown_timeout: Duration::from_secs(10),
            evict_interval: Some(Duration::from_secs(10 * 60)),
            retry_missing_interval: Some(Duration::from_secs(5 * 60)),
            restart_pause: Duration::from_secs(1),
            revive_delays: vec![
                Duration::from_secs(15 * 60),
                Duration::from_secs(3600),
                Duration::from_secs(6 * 3600),
                Duration::from_secs(24 * 3600),
            ],
            failed_retention: Duration::from_secs(30 * 24 * 3600),
        }
    }
}

impl WorkerConfig {
    fn backoff(&self, attempts: i32) -> Duration {
        let exp = attempts.saturating_sub(1).clamp(0, 30) as u32;
        self.backoff_base
            .checked_mul(2u32.saturating_pow(exp))
            .unwrap_or(self.backoff_max)
            .min(self.backoff_max)
    }
}

/// Сколько раз супервизор перезапускал циклы пула после паники. Ненулевое значение — повод
/// заглянуть в логи (`GET /api/health` → `workers`). Дёшево клонируется: счётчики общие.
#[derive(Debug, Clone, Default)]
pub struct WorkerStats {
    workers: Arc<AtomicU64>,
    maintenance: Arc<AtomicU64>,
    listener: Arc<AtomicU64>,
}

/// Снимок [`WorkerStats`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RestartCounts {
    pub workers: u64,
    pub maintenance: u64,
    pub listener: u64,
}

impl RestartCounts {
    /// Всего перезапусков.
    pub fn total(&self) -> u64 {
        self.workers + self.maintenance + self.listener
    }
}

impl WorkerStats {
    pub fn restarts(&self) -> RestartCounts {
        RestartCounts {
            workers: self.workers.load(Ordering::Relaxed),
            maintenance: self.maintenance.load(Ordering::Relaxed),
            listener: self.listener.load(Ordering::Relaxed),
        }
    }
}

pub struct WorkerPool {
    stats: WorkerStats,
    token: CancellationToken,
    tasks: JoinSet<()>,
    worker_ids: Vec<String>,
    db: PgPool,
    shutdown_timeout: Duration,
}

/// Задача tokio, которая прерывается при drop (иначе при `abort()` внешней задачи
/// обработчик, запущенный внутри неё, продолжил бы работать «сиротой»).
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Обработчики по виду задачи — для вызова `on_exhausted` из обслуживающего цикла.
type HandlerMap = Arc<HashMap<&'static str, Arc<dyn JobHandler>>>;

impl WorkerPool {
    /// Восстановление после падения + запуск: возвращает в очередь всё осиротевшее `running`
    /// (см. [`jobs::recover_orphans`]) и запускает воркеры. Так запускается боевой процесс.
    pub async fn start(
        ctx: JobCtx,
        handlers: Vec<(Arc<dyn JobHandler>, usize)>,
        cfg: WorkerConfig,
    ) -> sqlx::Result<Self> {
        let n = jobs::recover_orphans(&ctx.db).await?;
        if n > 0 {
            tracing::warn!(count = n, "returned orphaned running jobs to the queue");
        }
        Ok(Self::spawn(ctx, handlers, cfg))
    }

    /// Запускает воркеры: для каждого обработчика — `concurrency` циклов claim → handle → complete/fail,
    /// плюс слушатель `NOTIFY jobs` и фоновое обслуживание очереди.
    pub fn spawn(
        mut ctx: JobCtx,
        handlers: Vec<(Arc<dyn JobHandler>, usize)>,
        cfg: WorkerConfig,
    ) -> Self {
        let token = CancellationToken::new();
        ctx.cancel = token.child_token();
        let notify = Arc::new(Notify::new());
        let cfg = Arc::new(cfg);
        let mut tasks = JoinSet::new();
        let mut worker_ids = Vec::new();
        let mut by_kind: HashMap<&'static str, Arc<dyn JobHandler>> = HashMap::new();
        for (h, _) in &handlers {
            for k in h.kinds() {
                by_kind.insert(k, h.clone());
            }
        }
        let by_kind: HandlerMap = Arc::new(by_kind);

        let stats = WorkerStats::default();
        let pause = cfg.restart_pause;

        {
            let (db, notify, tk) = (ctx.db.clone(), notify.clone(), token.clone());
            tasks.spawn(supervise(
                "listener",
                token.clone(),
                pause,
                stats.listener.clone(),
                move || listen_loop(db.clone(), notify.clone(), tk.clone()),
            ));
        }
        {
            let (ctx, cfg, tk) = (ctx.clone(), cfg.clone(), token.clone());
            tasks.spawn(supervise(
                "maintenance",
                token.clone(),
                pause,
                stats.maintenance.clone(),
                move || maintenance_loop(ctx.clone(), by_kind.clone(), cfg.clone(), tk.clone()),
            ));
        }

        for (handler, concurrency) in handlers {
            for n in 0..concurrency.max(1) {
                let worker_id =
                    format!("{}-{}-{}", handler.kinds().join("+"), std::process::id(), n);
                worker_ids.push(worker_id.clone());
                let (handler, ctx, cfg, notify, tk) = (
                    handler.clone(),
                    ctx.clone(),
                    cfg.clone(),
                    notify.clone(),
                    token.clone(),
                );
                tasks.spawn(supervise(
                    "worker",
                    token.clone(),
                    pause,
                    stats.workers.clone(),
                    move || {
                        worker_loop(
                            worker_id.clone(),
                            handler.clone(),
                            ctx.clone(),
                            cfg.clone(),
                            notify.clone(),
                            tk.clone(),
                        )
                    },
                ));
            }
        }
        Self {
            stats,
            token,
            tasks,
            worker_ids,
            db: ctx.db.clone(),
            shutdown_timeout: cfg.shutdown_timeout,
        }
    }

    /// Счётчики перезапусков циклов (общие с пулом: клон видит обновления).
    pub fn stats(&self) -> WorkerStats {
        self.stats.clone()
    }

    /// Остановка: отменяет токен (новые задачи не берутся, обработчики получают `ctx.cancel`),
    /// ждёт до `shutdown_timeout`; не успевшие задачи прерываются, а их строки возвращаются
    /// в `queued` без траты попытки.
    pub async fn shutdown(mut self) {
        self.token.cancel();
        let tasks = &mut self.tasks;
        let wait = async { while tasks.join_next().await.is_some() {} };
        if tokio::time::timeout(self.shutdown_timeout, wait)
            .await
            .is_err()
        {
            tracing::warn!("worker shutdown timed out, aborting running jobs");
            self.tasks.abort_all();
            while self.tasks.join_next().await.is_some() {}
        }
        // Всё, что осталось `running` у наших воркеров (прервано или не успело записать итог), — в очередь.
        match jobs::release_workers(&self.db, &self.worker_ids).await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(count = n, "returned interrupted jobs to the queue"),
            Err(e) => tracing::error!(error = %e, "cannot release jobs on shutdown"),
        }
    }
}

/// Текст паники из `catch_unwind`.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic".into())
}

/// Выполняет цикл `make()` под защитой от паники: при панике пишет `error`, увеличивает `restarts`,
/// ждёт `pause` (отменяемо) и запускает цикл заново. Нормальное завершение (по отмене) — выход.
async fn supervise<F, Fut>(
    name: &'static str,
    token: CancellationToken,
    pause: Duration,
    restarts: Arc<AtomicU64>,
    make: F,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = ()>,
{
    loop {
        match AssertUnwindSafe(make()).catch_unwind().await {
            Ok(()) => return,
            Err(panic) => {
                restarts.fetch_add(1, Ordering::Relaxed);
                tracing::error!(task = name, panic = %panic_message(&*panic), "loop panicked, restarting");
                if sleep_or_cancel(pause, &token).await {
                    return;
                }
            }
        }
    }
}

/// Один шаг обслуживания: паника шага логируется и не мешает остальным шагам тика.
async fn guarded(step: &'static str, fut: impl Future<Output = ()>) {
    if let Err(panic) = AssertUnwindSafe(fut).catch_unwind().await {
        tracing::error!(step, panic = %panic_message(&*panic), "maintenance step panicked");
    }
}

async fn listen_loop(db: PgPool, notify: Arc<Notify>, token: CancellationToken) {
    while !token.is_cancelled() {
        let mut listener = match PgListener::connect_with(&db).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "job listener connect failed");
                if sleep_or_cancel(Duration::from_secs(2), &token).await {
                    return;
                }
                continue;
            }
        };
        if let Err(e) = listener.listen(jobs::NOTIFY_CHANNEL).await {
            tracing::warn!(error = %e, "LISTEN failed");
            if sleep_or_cancel(Duration::from_secs(2), &token).await {
                return;
            }
            continue;
        }
        loop {
            tokio::select! {
                _ = token.cancelled() => return,
                res = listener.recv() => match res {
                    Ok(_) => notify.notify_waiters(),
                    Err(e) => {
                        tracing::warn!(error = %e, "job listener error");
                        break;
                    }
                }
            }
        }
    }
}

/// true, если во время сна пришла отмена.
async fn sleep_or_cancel(d: Duration, token: &CancellationToken) -> bool {
    tokio::select! {
        _ = token.cancelled() => true,
        _ = tokio::time::sleep(d) => false,
    }
}

/// Как часто чистить надгробия синхронизации.
const SYNC_PURGE_EVERY: Duration = Duration::from_secs(24 * 3600);

/// Отметки времени периодических шагов обслуживания.
struct MaintClock {
    purge: std::time::Instant,
    sync_purge: std::time::Instant,
    imports: std::time::Instant,
    evict: std::time::Instant,
    retry_missing: std::time::Instant,
}

async fn maintenance_loop(
    ctx: JobCtx,
    handlers: HandlerMap,
    cfg: Arc<WorkerConfig>,
    token: CancellationToken,
) {
    let mut clock = MaintClock {
        purge: std::time::Instant::now() - Duration::from_secs(24 * 3600),
        sync_purge: std::time::Instant::now() - SYNC_PURGE_EVERY,
        imports: std::time::Instant::now() - Duration::from_secs(24 * 3600),
        evict: std::time::Instant::now(),
        retry_missing: std::time::Instant::now(),
    };
    loop {
        guarded("requeue_stale", requeue_stale_step(&ctx, &handlers, &cfg)).await;
        guarded("revive_failed", revive_step(&ctx, &handlers, &cfg)).await;
        guarded("finalize_stuck_albums", finalize_stuck_step(&ctx, &cfg)).await;
        guarded("purge", purge_step(&ctx, &cfg, &mut clock)).await;
        guarded("sync_purge", sync_purge_step(&ctx, &cfg, &mut clock)).await;
        guarded("missing_imports", missing_imports_step(&ctx, &mut clock)).await;
        guarded(
            "enqueue_periodic",
            enqueue_periodic_step(&ctx, &cfg, &mut clock),
        )
        .await;
        if sleep_or_cancel(cfg.maintenance_interval, &token).await {
            return;
        }
    }
}

/// Возвращает зависшие `running` в очередь; исчерпавшим попытки вызывает `on_exhausted`.
async fn requeue_stale_step(ctx: &JobCtx, handlers: &HandlerMap, cfg: &WorkerConfig) {
    match jobs::requeue_stale(&ctx.db, cfg.stale_after).await {
        Ok(out) => {
            if out.requeued > 0 {
                tracing::warn!(count = out.requeued, "requeued stale jobs");
            }
            for row in &out.failed {
                tracing::warn!(job_id = row.id, kind = %row.kind, "stale job exhausted its attempts");
                exhausted(handlers, ctx, row, "worker lost; attempts exhausted").await;
            }
        }
        Err(e) => tracing::error!(error = %e, "requeue_stale failed"),
    }
}

/// Виды задач, которые оживляет обслуживание. Остальные упавшие задачи не оживают: у `discover_album`,
/// `verify_torrent` и `process_cue` повтор идёт на уровне альбома (`on_exhausted` + `RetryMissing`),
/// а у этих двух другого пути повтора нет.
const REVIVABLE_KINDS: [&str; 2] = [Job::IMPORT_ARTIST, Job::DISCOVER_ARTIST];

/// Оживляет упавшие `import_artist` / `discover_artist` после растущей паузы; хуку `on_retry`
/// сообщает причину `revived` (интерфейс увидит «импорт идёт»).
async fn revive_step(ctx: &JobCtx, handlers: &HandlerMap, cfg: &WorkerConfig) {
    match jobs::revive_failed(&ctx.db, &REVIVABLE_KINDS, &cfg.revive_delays).await {
        Ok(rows) => {
            for row in &rows {
                tracing::warn!(job_id = row.id, kind = %row.kind, revivals = row.revivals, "failed job revived");
                if let (Some(handler), Ok(job)) = (handlers.get(row.kind.as_str()), row.job()) {
                    run_on_retry(handler, &job, ctx, "revived").await;
                }
            }
        }
        Err(e) => tracing::error!(error = %e, "revive_failed failed"),
    }
}

async fn finalize_stuck_step(ctx: &JobCtx, cfg: &WorkerConfig) {
    match crate::verify::finalize_stuck_albums(ctx, cfg.stuck_grace).await {
        Ok(0) => {}
        Ok(n) => tracing::warn!(count = n, "finalized albums stuck in adding"),
        Err(e) => tracing::error!(error = %e, "finalize_stuck_albums failed"),
    }
}

/// Раз в час: уборка завершённых задач и просроченного кэша MusicBrainz.
async fn purge_step(ctx: &JobCtx, cfg: &WorkerConfig, clock: &mut MaintClock) {
    if clock.purge.elapsed() <= Duration::from_secs(3600) {
        return;
    }
    clock.purge = std::time::Instant::now();
    if let Err(e) = jobs::purge_done(&ctx.db, cfg.done_retention).await {
        tracing::error!(error = %e, "purge_done failed");
    }
    if let Err(e) = jobs::purge_failed(&ctx.db, cfg.failed_retention).await {
        tracing::error!(error = %e, "purge_failed failed");
    }
    // Просроченные ответы MusicBrainz живут ещё `STALE_GRACE` как запасной вариант при отказах.
    if let Err(e) =
        nimbus_db::repo::mb_cache::purge_expired(&ctx.db, nimbus_db::repo::mb_cache::STALE_GRACE)
            .await
    {
        tracing::error!(error = %e, "mb_cache purge failed");
    }
}

/// Сколько артист может быть в библиотеке без альбомов и без задачи импорта, прежде чем
/// страховка поставит импорт сама.
const IMPORT_GRACE: Duration = Duration::from_secs(15 * 60);

/// Раз в час: артисты в библиотеке без альбомов и без задачи `import_artist` (потерянная
/// постановка) получают импорт.
async fn missing_imports_step(ctx: &JobCtx, clock: &mut MaintClock) {
    if clock.imports.elapsed() <= Duration::from_secs(3600) {
        return;
    }
    clock.imports = std::time::Instant::now();
    let ids = match nimbus_db::repo::artists::without_import(&ctx.db, IMPORT_GRACE).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::error!(error = %e, "artists without import lookup failed");
            return;
        }
    };
    for id in ids {
        tracing::warn!(
            artist_id = id,
            "artist in the library has no import job; queueing it"
        );
        if let Err(e) = nimbus_library::enqueue_import_in(&ctx.db, id).await {
            tracing::error!(artist_id = id, error = %e, "cannot enqueue artist import");
        }
    }
}

async fn sync_purge_step(ctx: &JobCtx, cfg: &WorkerConfig, clock: &mut MaintClock) {
    if clock.sync_purge.elapsed() < SYNC_PURGE_EVERY {
        return;
    }
    clock.sync_purge = std::time::Instant::now();
    match nimbus_db::repo::sync::purge_tombstones(&ctx.db, cfg.tombstone_retention).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(count = n, "purged old sync tombstones"),
        Err(e) => tracing::error!(error = %e, "sync tombstone purge failed"),
    }
}

/// Периодические задачи: вытеснение кэша и автоповтор поиска.
async fn enqueue_periodic_step(ctx: &JobCtx, cfg: &WorkerConfig, clock: &mut MaintClock) {
    let db = &ctx.db;
    if cfg
        .evict_interval
        .is_some_and(|i| clock.evict.elapsed() >= i)
    {
        clock.evict = std::time::Instant::now();
        if let Err(e) = jobs::enqueue(
            db,
            &Job::EvictCache,
            jobs::EnqueueOpts::priority(PRIORITY_BACKGROUND),
        )
        .await
        {
            tracing::error!(error = %e, "cannot enqueue cache eviction");
        }
    }
    if cfg
        .retry_missing_interval
        .is_some_and(|i| clock.retry_missing.elapsed() >= i)
    {
        clock.retry_missing = std::time::Instant::now();
        if ctx.settings.get().search.auto_retry {
            if let Err(e) = jobs::enqueue(
                db,
                &Job::RetryMissing,
                jobs::EnqueueOpts::priority(PRIORITY_BACKGROUND),
            )
            .await
            {
                tracing::error!(error = %e, "cannot enqueue retry_missing");
            }
        }
    }
}

/// Вызывает `on_exhausted` обработчика задачи, ставшей `failed`. Ошибка хука логируется:
/// задача уже окончательно провалена, повторять нечего.
async fn exhausted(handlers: &HandlerMap, ctx: &JobCtx, row: &JobRow, reason: &str) {
    let Some(handler) = handlers.get(row.kind.as_str()) else {
        return;
    };
    let Ok(job) = row.job() else { return };
    run_exhausted(handler, &job, ctx, row.id, reason, false).await;
}

/// Сколько раз пробуем хук исчерпания, прежде чем сдаться, и пауза между попытками.
const EXHAUSTED_TRIES: u32 = 3;
const EXHAUSTED_PAUSE: Duration = Duration::from_millis(500);

/// Вызывает `on_exhausted` с несколькими попытками: хук чаще всего упирается во временную ошибку БД,
/// а потеря очистки оставила бы альбом навсегда «в процессе». Если не вышло — ошибка в логе.
async fn run_exhausted(
    handler: &Arc<dyn JobHandler>,
    job: &Job,
    ctx: &JobCtx,
    job_id: i64,
    reason: &str,
    fatal: bool,
) {
    for attempt in 1..=EXHAUSTED_TRIES {
        let (h, j, c, r) = (
            handler.clone(),
            job.clone(),
            ctx.clone(),
            reason.to_string(),
        );
        // Отдельная задача: паника хука — такая же ошибка хука, цикл воркера она не роняет.
        let mut task = AbortOnDrop(tokio::spawn(async move {
            h.on_exhausted(&j, &c, &r, fatal).await
        }));
        match (&mut task.0).await {
            Ok(Ok(())) => return,
            Ok(Err(e)) => {
                tracing::error!(job_id, error = %e, attempt, "on_exhausted failed");
                if attempt < EXHAUSTED_TRIES {
                    tokio::time::sleep(EXHAUSTED_PAUSE).await;
                }
            }
            Err(e) => {
                tracing::error!(job_id, error = %e, attempt, "on_exhausted panicked");
                if attempt < EXHAUSTED_TRIES {
                    tokio::time::sleep(EXHAUSTED_PAUSE).await;
                }
            }
        }
    }
}

async fn worker_loop(
    worker_id: String,
    handler: Arc<dyn JobHandler>,
    ctx: JobCtx,
    cfg: Arc<WorkerConfig>,
    notify: Arc<Notify>,
    token: CancellationToken,
) {
    let kinds = handler.kinds();
    // Цикл мог быть перезапущен после паники посреди `process`: строка `running` за этим воркером
    // осиротела. Возвращаем её без траты попытки — виноват не обработчик.
    match jobs::release_workers(&ctx.db, std::slice::from_ref(&worker_id)).await {
        Ok(0) => {}
        Ok(n) => {
            tracing::warn!(count = n, worker = %worker_id, "returned own running jobs to the queue")
        }
        Err(e) => tracing::error!(error = %e, worker = %worker_id, "release own jobs failed"),
    }
    while !token.is_cancelled() {
        // Создаём до claim, чтобы не потерять NOTIFY между claim и ожиданием.
        let notified = notify.notified();
        match jobs::claim(&ctx.db, &worker_id, kinds).await {
            Ok(Some(row)) => {
                process(&worker_id, &row, &handler, &ctx, &cfg).await;
                continue;
            }
            Ok(None) => {}
            Err(e) => tracing::error!(error = %e, worker = %worker_id, "claim failed"),
        }
        tokio::select! {
            _ = token.cancelled() => break,
            _ = notified => {}
            _ = tokio::time::sleep(cfg.poll_interval) => {}
        }
    }
    tracing::debug!(worker = %worker_id, "worker stopped");
}

/// Вызывает `on_retry` в отдельной задаче: паника хука логируется и не роняет цикл воркера.
async fn run_on_retry(handler: &Arc<dyn JobHandler>, job: &Job, ctx: &JobCtx, reason: &str) {
    let (h, j, c, r) = (
        handler.clone(),
        job.clone(),
        ctx.clone(),
        reason.to_string(),
    );
    let mut task = AbortOnDrop(tokio::spawn(async move { h.on_retry(&j, &c, &r).await }));
    if let Err(e) = (&mut task.0).await {
        tracing::error!(error = %e, "on_retry panicked");
    }
}

/// Пока задача выполняется, раз в `every` отмечает, что воркер жив.
async fn heartbeat_loop(
    db: PgPool,
    id: i64,
    worker_id: String,
    every: Duration,
    lost: CancellationToken,
) {
    loop {
        tokio::time::sleep(every).await;
        match jobs::heartbeat(&db, id, &worker_id).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(
                    job_id = id,
                    "job no longer belongs to this worker; heartbeat stopped"
                );
                // Задачу перехватили: прерываем обработчик, чтобы он не работал параллельно с новым владельцем.
                lost.cancel();
                return;
            }
            Err(e) => tracing::warn!(job_id = id, error = %e, "heartbeat failed"),
        }
    }
}

/// Итог не записан: задачу перехватил другой воркер (он и запишет итог; хуки не вызываем).
fn log_taken_over(row: &JobRow, worker_id: &str) {
    tracing::warn!(job_id = row.id, kind = %row.kind, worker = worker_id, "job was taken over; result dropped");
}

async fn process(
    worker_id: &str,
    row: &JobRow,
    handler: &Arc<dyn JobHandler>,
    ctx: &JobCtx,
    cfg: &WorkerConfig,
) {
    let job = match row.job() {
        Ok(j) => j,
        Err(e) => {
            tracing::error!(job_id = row.id, kind = %row.kind, dedup_key = ?row.dedup_key, error = %e, "unparsable job payload");
            match jobs::fail(
                &ctx.db,
                row.id,
                worker_id,
                &format!("bad payload: {e}"),
                None,
                true,
            )
            .await
            {
                Ok(Some(_)) => {}
                Ok(None) => log_taken_over(row, worker_id),
                Err(e) => tracing::error!(job_id = row.id, error = %e, "fail update failed"),
            }
            return;
        }
    };

    // Токен задачи: дочерний от отмены пула; heartbeat отменяет его при потере владения.
    let job_cancel = ctx.cancel.child_token();
    let mut heartbeat = AbortOnDrop(tokio::spawn(heartbeat_loop(
        ctx.db.clone(),
        row.id,
        worker_id.to_string(),
        cfg.heartbeat_interval,
        job_cancel.clone(),
    )));
    // Отдельная задача: паника в обработчике не убивает воркер. При drop (abort воркера
    // на остановке) прерывается и она.
    let h = handler.clone();
    let mut c = ctx.clone();
    c.attempt = row.attempts;
    c.max_attempts = row.max_attempts;
    c.priority = row.priority;
    c.cancel = job_cancel;
    let handled_job = job.clone();
    let mut task = AbortOnDrop(tokio::spawn(async move { h.handle(handled_job, &c).await }));
    let result = (&mut task.0).await;
    // Heartbeat гасим до записи итога: иначе он мог бы «оживить» уже завершённую строку.
    heartbeat.0.abort();
    let _ = (&mut heartbeat.0).await;

    let fatal = matches!(result, Ok(Err(JobError::Fatal(_))));
    let (reason, delay) = match result {
        Ok(Ok(())) => {
            match jobs::complete(&ctx.db, row.id, worker_id).await {
                Ok(jobs::Completion::Done) => {}
                Ok(jobs::Completion::Requeued) => {
                    tracing::debug!(job_id = row.id, kind = %row.kind, "request arrived during the run; job queued again");
                }
                Ok(jobs::Completion::Lost) => log_taken_over(row, worker_id),
                Err(e) => tracing::error!(job_id = row.id, error = %e, "complete failed"),
            }
            return;
        }
        Ok(Err(JobError::Cancelled)) => {
            match jobs::release(&ctx.db, row.id, worker_id).await {
                Ok(true) => {
                    tracing::info!(job_id = row.id, kind = %row.kind, "job cancelled, returned to the queue");
                }
                Ok(false) => log_taken_over(row, worker_id),
                Err(e) => tracing::error!(job_id = row.id, error = %e, "release failed"),
            }
            return;
        }
        Ok(Err(JobError::Defer { after, reason })) => {
            let retry_at = Utc::now() + chrono::Duration::from_std(after).unwrap_or_default();
            tracing::info!(job_id = row.id, kind = %row.kind, %reason, ?after, "job deferred");
            match jobs::defer(&ctx.db, row.id, worker_id, &reason, retry_at, DEFER_MAX_AGE).await {
                Ok(Some(updated)) if updated.state == "failed" => {
                    run_exhausted(handler, &job, ctx, row.id, &reason, false).await;
                }
                Ok(Some(_)) => run_on_retry(handler, &job, ctx, &reason).await,
                Ok(None) => log_taken_over(row, worker_id),
                Err(e) => tracing::error!(job_id = row.id, error = %e, "defer update failed"),
            }
            return;
        }
        Ok(Err(JobError::Retry { after, reason })) => (reason, Some(after)),
        Ok(Err(JobError::Fatal(reason))) => (reason, None),
        Ok(Err(JobError::Unexpected(reason))) => (reason, Some(cfg.backoff(row.attempts))),
        Err(join_err) => (
            format!("handler panicked: {join_err}"),
            Some(cfg.backoff(row.attempts)),
        ),
    };
    let retry_at = delay.map(|d| Utc::now() + chrono::Duration::from_std(d).unwrap_or_default());
    tracing::warn!(job_id = row.id, kind = %row.kind, attempts = row.attempts, %reason, retry = retry_at.is_some(), "job failed");
    match jobs::fail(&ctx.db, row.id, worker_id, &reason, retry_at, fatal).await {
        Ok(Some(updated)) if updated.state == "failed" => {
            run_exhausted(handler, &job, ctx, row.id, &reason, fatal).await;
        }
        Ok(Some(_)) => run_on_retry(handler, &job, ctx, &reason).await,
        Ok(None) => log_taken_over(row, worker_id),
        Err(e) => tracing::error!(job_id = row.id, error = %e, "fail update failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    #[test]
    fn backoff_doubles_and_caps() {
        let cfg = WorkerConfig::default();
        assert_eq!(cfg.backoff(1), Duration::from_secs(30));
        assert_eq!(cfg.backoff(2), Duration::from_secs(60));
        assert_eq!(cfg.backoff(3), Duration::from_secs(120));
        assert_eq!(cfg.backoff(20), Duration::from_secs(30 * 60));
        assert_eq!(cfg.backoff(1000), Duration::from_secs(30 * 60));
    }

    #[tokio::test]
    async fn supervisor_restarts_panicking_loop_and_counts_it() {
        let runs = Arc::new(AtomicU32::new(0));
        let restarts = Arc::new(AtomicU64::new(0));
        let r = runs.clone();
        supervise(
            "test",
            CancellationToken::new(),
            Duration::from_millis(1),
            restarts.clone(),
            move || {
                let r = r.clone();
                async move {
                    if r.fetch_add(1, Ordering::SeqCst) < 2 {
                        panic!("boom");
                    }
                }
            },
        )
        .await;
        assert_eq!(runs.load(Ordering::SeqCst), 3);
        assert_eq!(restarts.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn supervisor_stops_on_cancel_during_restart_pause() {
        let token = CancellationToken::new();
        let restarts = Arc::new(AtomicU64::new(0));
        let task = tokio::spawn(supervise(
            "test",
            token.clone(),
            Duration::from_secs(3600),
            restarts.clone(),
            || async { panic!("boom") },
        ));
        while restarts.load(Ordering::Relaxed) == 0 {
            tokio::task::yield_now().await;
        }
        token.cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("supervisor must not hang in the restart pause")
            .unwrap();
        assert_eq!(restarts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn panic_message_reads_str_string_and_other_payloads() {
        assert_eq!(panic_message(&"static"), "static");
        assert_eq!(panic_message(&String::from("owned")), "owned");
        assert_eq!(panic_message(&42_u32), "non-string panic");
    }

    #[tokio::test]
    async fn guarded_step_swallows_panic() {
        guarded("test", async { panic!("boom") }).await;
    }

    #[test]
    fn stats_snapshot_sums_counters() {
        let s = WorkerStats::default();
        s.workers.fetch_add(2, Ordering::Relaxed);
        s.maintenance.fetch_add(1, Ordering::Relaxed);
        s.listener.fetch_add(4, Ordering::Relaxed);
        let c = s.clone().restarts();
        assert_eq!(
            (c.workers, c.maintenance, c.listener, c.total()),
            (2, 1, 4, 7)
        );
    }

    /// `kinds()` паникует при первом вызове цикла — имитация паники вне `process`.
    struct PanicsOnce {
        kinds_calls: AtomicU32,
        seen_attempt: std::sync::Mutex<Vec<i32>>,
    }

    #[async_trait]
    impl JobHandler for PanicsOnce {
        fn kinds(&self) -> &'static [&'static str] {
            if self.kinds_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("loop boom");
            }
            &["discover_album"]
        }
        async fn handle(&self, _job: Job, ctx: &JobCtx) -> Result<(), JobError> {
            self.seen_attempt.lock().unwrap().push(ctx.attempt);
            Ok(())
        }
    }

    #[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
    async fn restarted_worker_releases_its_running_job(pool: PgPool) {
        let id = jobs::enqueue(
            &pool,
            &Job::DiscoverAlbum { album_id: 1 },
            jobs::EnqueueOpts::default(),
        )
        .await
        .unwrap()
        .unwrap();
        // Строка `running` за воркером, который «умер» посреди `process`.
        let row = jobs::claim(&pool, "w-0", &["discover_album"])
            .await
            .unwrap()
            .unwrap();
        assert_eq!((row.id, row.attempts), (id, 1));

        let h = Arc::new(PanicsOnce {
            kinds_calls: AtomicU32::new(0),
            seen_attempt: Default::default(),
        });
        let ctx = JobCtx::new(
            pool.clone(),
            EventBus::new(),
            nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None)
                .unwrap(),
            Arc::new(ProviderRegistry::new(vec![])),
        );
        let token = CancellationToken::new();
        let restarts = Arc::new(AtomicU64::new(0));
        let task = tokio::spawn({
            let (h, ctx, token, restarts) = (h.clone(), ctx, token.clone(), restarts.clone());
            let cfg = Arc::new(WorkerConfig {
                poll_interval: Duration::from_millis(20),
                ..WorkerConfig::default()
            });
            let notify = Arc::new(Notify::new());
            supervise(
                "worker",
                token.clone(),
                Duration::from_millis(5),
                restarts,
                move || {
                    worker_loop(
                        "w-0".into(),
                        h.clone() as Arc<dyn JobHandler>,
                        ctx.clone(),
                        cfg.clone(),
                        notify.clone(),
                        token.clone(),
                    )
                },
            )
        });
        nimbus_testkit::eventually(Duration::from_secs(5), || async {
            !h.seen_attempt.lock().unwrap().is_empty()
        })
        .await;
        token.cancel();
        task.await.unwrap();
        assert_eq!(restarts.load(Ordering::Relaxed), 1);
        // Попытка возвращена при перезапуске: повторный запуск — снова первая попытка.
        assert_eq!(*h.seen_attempt.lock().unwrap(), vec![1]);
    }
}
