use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
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

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    /// Временная ошибка: повторить через `after`.
    #[error("retry in {after:?}: {reason}")]
    Retry { after: Duration, reason: String },
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
    async fn on_exhausted(&self, _job: &Job, _ctx: &JobCtx, _reason: &str) -> Result<(), JobError> {
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
            retry_missing_interval: Some(Duration::from_secs(15 * 60)),
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

pub struct WorkerPool {
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

        tasks.spawn(listen_loop(ctx.db.clone(), notify.clone(), token.clone()));
        tasks.spawn(maintenance_loop(
            ctx.clone(),
            by_kind,
            cfg.clone(),
            token.clone(),
        ));

        for (handler, concurrency) in handlers {
            for n in 0..concurrency.max(1) {
                let worker_id =
                    format!("{}-{}-{}", handler.kinds().join("+"), std::process::id(), n);
                worker_ids.push(worker_id.clone());
                tasks.spawn(worker_loop(
                    worker_id,
                    handler.clone(),
                    ctx.clone(),
                    cfg.clone(),
                    notify.clone(),
                    token.clone(),
                ));
            }
        }
        Self {
            token,
            tasks,
            worker_ids,
            db: ctx.db.clone(),
            shutdown_timeout: cfg.shutdown_timeout,
        }
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

async fn maintenance_loop(
    ctx: JobCtx,
    handlers: HandlerMap,
    cfg: Arc<WorkerConfig>,
    token: CancellationToken,
) {
    let db = &ctx.db;
    let mut last_purge = std::time::Instant::now() - Duration::from_secs(24 * 3600);
    let mut last_sync_purge = std::time::Instant::now() - SYNC_PURGE_EVERY;
    let mut last_evict = std::time::Instant::now();
    let mut last_retry_missing = std::time::Instant::now();
    loop {
        match jobs::requeue_stale(db, cfg.stale_after).await {
            Ok(out) => {
                if out.requeued > 0 {
                    tracing::warn!(count = out.requeued, "requeued stale jobs");
                }
                for row in &out.failed {
                    tracing::warn!(job_id = row.id, kind = %row.kind, "stale job exhausted its attempts");
                    exhausted(&handlers, &ctx, row, "worker lost; attempts exhausted").await;
                }
            }
            Err(e) => tracing::error!(error = %e, "requeue_stale failed"),
        }
        match crate::verify::finalize_stuck_albums(&ctx, cfg.stuck_grace).await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(count = n, "finalized albums stuck in adding"),
            Err(e) => tracing::error!(error = %e, "finalize_stuck_albums failed"),
        }
        if last_purge.elapsed() > Duration::from_secs(3600) {
            last_purge = std::time::Instant::now();
            if let Err(e) = jobs::purge_done(db, cfg.done_retention).await {
                tracing::error!(error = %e, "purge_done failed");
            }
            // Просроченные ответы MusicBrainz живут ещё `STALE_GRACE` как запасной вариант при отказах.
            if let Err(e) =
                nimbus_db::repo::mb_cache::purge_expired(db, nimbus_db::repo::mb_cache::STALE_GRACE)
                    .await
            {
                tracing::error!(error = %e, "mb_cache purge failed");
            }
        }
        if last_sync_purge.elapsed() >= SYNC_PURGE_EVERY {
            last_sync_purge = std::time::Instant::now();
            match nimbus_db::repo::sync::purge_tombstones(db, cfg.tombstone_retention).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(count = n, "purged old sync tombstones"),
                Err(e) => tracing::error!(error = %e, "sync tombstone purge failed"),
            }
        }
        if cfg
            .evict_interval
            .is_some_and(|i| last_evict.elapsed() >= i)
        {
            last_evict = std::time::Instant::now();
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
            .is_some_and(|i| last_retry_missing.elapsed() >= i)
        {
            last_retry_missing = std::time::Instant::now();
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
        if sleep_or_cancel(cfg.maintenance_interval, &token).await {
            return;
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
    run_exhausted(handler, &job, ctx, row.id, reason).await;
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
) {
    for attempt in 1..=EXHAUSTED_TRIES {
        match handler.on_exhausted(job, ctx, reason).await {
            Ok(()) => return,
            Err(e) => {
                tracing::error!(job_id, error = %e, attempt, "on_exhausted failed");
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

/// Пока задача выполняется, раз в `every` отмечает, что воркер жив.
async fn heartbeat_loop(db: PgPool, id: i64, worker_id: String, every: Duration) {
    loop {
        tokio::time::sleep(every).await;
        match jobs::heartbeat(&db, id, &worker_id).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(
                    job_id = id,
                    "job no longer belongs to this worker; heartbeat stopped"
                );
                return;
            }
            Err(e) => tracing::warn!(job_id = id, error = %e, "heartbeat failed"),
        }
    }
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
            tracing::error!(job_id = row.id, kind = %row.kind, error = %e, "unparsable job payload");
            if let Err(e) = jobs::fail(&ctx.db, row.id, &format!("bad payload: {e}"), None).await {
                tracing::error!(job_id = row.id, error = %e, "fail update failed");
            }
            return;
        }
    };

    let mut heartbeat = AbortOnDrop(tokio::spawn(heartbeat_loop(
        ctx.db.clone(),
        row.id,
        worker_id.to_string(),
        cfg.heartbeat_interval,
    )));
    // Отдельная задача: паника в обработчике не убивает воркер. При drop (abort воркера
    // на остановке) прерывается и она.
    let h = handler.clone();
    let mut c = ctx.clone();
    c.attempt = row.attempts;
    c.max_attempts = row.max_attempts;
    c.priority = row.priority;
    let handled_job = job.clone();
    let mut task = AbortOnDrop(tokio::spawn(async move { h.handle(handled_job, &c).await }));
    let result = (&mut task.0).await;
    // Heartbeat гасим до записи итога: иначе он мог бы «оживить» уже завершённую строку.
    heartbeat.0.abort();
    let _ = (&mut heartbeat.0).await;

    let (reason, delay) = match result {
        Ok(Ok(())) => {
            if let Err(e) = jobs::complete(&ctx.db, row.id).await {
                tracing::error!(job_id = row.id, error = %e, "complete failed");
            }
            return;
        }
        Ok(Err(JobError::Cancelled)) => {
            tracing::info!(job_id = row.id, kind = %row.kind, "job cancelled, returned to the queue");
            if let Err(e) = jobs::release(&ctx.db, row.id).await {
                tracing::error!(job_id = row.id, error = %e, "release failed");
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
    match jobs::fail(&ctx.db, row.id, &reason, retry_at).await {
        Ok(updated) if updated.state == "failed" => {
            run_exhausted(handler, &job, ctx, row.id, &reason).await;
        }
        Ok(_) => handler.on_retry(&job, ctx, &reason).await,
        Err(e) => tracing::error!(job_id = row.id, error = %e, "fail update failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        let cfg = WorkerConfig::default();
        assert_eq!(cfg.backoff(1), Duration::from_secs(30));
        assert_eq!(cfg.backoff(2), Duration::from_secs(60));
        assert_eq!(cfg.backoff(3), Duration::from_secs(120));
        assert_eq!(cfg.backoff(20), Duration::from_secs(30 * 60));
        assert_eq!(cfg.backoff(1000), Duration::from_secs(30 * 60));
    }
}
