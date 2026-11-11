use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use nimbus_core::events::EventBus;
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs::{self, JobRow};
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::TorrentEngine;
use nimbus_trackers::ProviderRegistry;
use sqlx::postgres::PgListener;
use sqlx::PgPool;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
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
    /// Номер текущей попытки (с 1) и лимит попыток задачи; выставляются раннером перед вызовом.
    pub attempt: i32,
    pub max_attempts: i32,
}

impl JobCtx {
    pub fn new(
        db: PgPool,
        events: EventBus,
        mb: MbClient,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            db,
            events,
            mb,
            providers,
            engine: None,
            attempt: 1,
            max_attempts: 1,
        }
    }

    pub fn with_engine(mut self, engine: Arc<TorrentEngine>) -> Self {
        self.engine = Some(engine);
        self
    }

    pub fn engine(&self) -> Result<&Arc<TorrentEngine>, JobError> {
        self.engine
            .as_ref()
            .ok_or_else(|| JobError::Fatal("torrent engine is not configured".into()))
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
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Базовая задержка backoff: `base * 2^(attempts-1)`.
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Как часто опрашивать очередь, если нет NOTIFY.
    pub poll_interval: Duration,
    /// Сколько `running` считается зависшим.
    pub stale_after: Duration,
    pub maintenance_interval: Duration,
    pub done_retention: Duration,
    pub shutdown_timeout: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_secs(30),
            backoff_max: Duration::from_secs(30 * 60),
            poll_interval: Duration::from_secs(5),
            stale_after: Duration::from_secs(10 * 60),
            maintenance_interval: Duration::from_secs(60),
            done_retention: Duration::from_secs(7 * 24 * 3600),
            shutdown_timeout: Duration::from_secs(10),
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
    tasks: Vec<JoinHandle<()>>,
    shutdown_timeout: Duration,
}

impl WorkerPool {
    /// Запускает воркеры: для каждого обработчика — `concurrency` циклов claim → handle → complete/fail,
    /// плюс слушатель `NOTIFY jobs` и фоновое обслуживание очереди.
    pub fn spawn(
        ctx: JobCtx,
        handlers: Vec<(Arc<dyn JobHandler>, usize)>,
        cfg: WorkerConfig,
    ) -> Self {
        let token = CancellationToken::new();
        let notify = Arc::new(Notify::new());
        let cfg = Arc::new(cfg);
        let mut tasks = Vec::new();

        tasks.push(tokio::spawn(listen_loop(
            ctx.db.clone(),
            notify.clone(),
            token.clone(),
        )));
        tasks.push(tokio::spawn(maintenance_loop(
            ctx.db.clone(),
            cfg.clone(),
            token.clone(),
        )));

        for (handler, concurrency) in handlers {
            for n in 0..concurrency.max(1) {
                let worker_id =
                    format!("{}-{}-{}", handler.kinds().join("+"), std::process::id(), n);
                tasks.push(tokio::spawn(worker_loop(
                    worker_id,
                    handler.clone(),
                    ctx.clone(),
                    cfg.clone(),
                    notify.clone(),
                    token.clone(),
                )));
            }
        }
        Self {
            token,
            tasks,
            shutdown_timeout: cfg.shutdown_timeout,
        }
    }

    /// Перестаёт брать новые задачи и ждёт текущие (до `shutdown_timeout`).
    pub async fn shutdown(self) {
        self.token.cancel();
        let wait = futures_join_all(self.tasks);
        if tokio::time::timeout(self.shutdown_timeout, wait)
            .await
            .is_err()
        {
            tracing::warn!("worker shutdown timed out, some jobs are still running");
        }
    }
}

async fn futures_join_all(tasks: Vec<JoinHandle<()>>) {
    for t in tasks {
        let _ = t.await;
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

async fn maintenance_loop(db: PgPool, cfg: Arc<WorkerConfig>, token: CancellationToken) {
    let mut last_purge = std::time::Instant::now() - Duration::from_secs(24 * 3600);
    loop {
        match jobs::requeue_stale(&db, cfg.stale_after).await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(count = n, "requeued stale jobs"),
            Err(e) => tracing::error!(error = %e, "requeue_stale failed"),
        }
        if last_purge.elapsed() > Duration::from_secs(3600) {
            last_purge = std::time::Instant::now();
            if let Err(e) = jobs::purge_done(&db, cfg.done_retention).await {
                tracing::error!(error = %e, "purge_done failed");
            }
        }
        if sleep_or_cancel(cfg.maintenance_interval, &token).await {
            return;
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
                process(&row, &handler, &ctx, &cfg).await;
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

async fn process(row: &JobRow, handler: &Arc<dyn JobHandler>, ctx: &JobCtx, cfg: &WorkerConfig) {
    let job = match row.job() {
        Ok(j) => j,
        Err(e) => {
            tracing::error!(job_id = row.id, kind = %row.kind, error = %e, "unparsable job payload");
            let _ = jobs::fail(&ctx.db, row.id, &format!("bad payload: {e}"), None).await;
            return;
        }
    };

    // Отдельная задача: паника в обработчике не убивает воркер.
    let h = handler.clone();
    let mut c = ctx.clone();
    c.attempt = row.attempts;
    c.max_attempts = row.max_attempts;
    let result = tokio::spawn(async move { h.handle(job, &c).await }).await;

    let outcome = match result {
        Ok(Ok(())) => {
            if let Err(e) = jobs::complete(&ctx.db, row.id).await {
                tracing::error!(job_id = row.id, error = %e, "complete failed");
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
    let (reason, delay) = outcome;
    let retry_at = delay.map(|d| Utc::now() + chrono::Duration::from_std(d).unwrap_or_default());
    tracing::warn!(job_id = row.id, kind = %row.kind, attempts = row.attempts, %reason, retry = retry_at.is_some(), "job failed");
    if let Err(e) = jobs::fail(&ctx.db, row.id, &reason, retry_at).await {
        tracing::error!(job_id = row.id, error = %e, "fail update failed");
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
