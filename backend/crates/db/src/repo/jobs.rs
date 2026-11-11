//! Очередь задач поверх таблицы `jobs`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use nimbus_core::jobs::Job;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgExecutor;

/// Канал `NOTIFY`, по которому раннер просыпается при постановке задачи.
pub const NOTIFY_CHANNEL: &str = "jobs";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub id: i64,
    pub kind: String,
    pub payload: Value,
    pub state: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub run_after: DateTime<Utc>,
    pub locked_at: Option<DateTime<Utc>>,
    pub locked_by: Option<String>,
    pub last_error: Option<String>,
    pub dedup_key: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRow {
    pub fn job(&self) -> Result<Job, serde_json::Error> {
        Job::from_parts(&self.kind, self.payload.clone())
    }
}

/// Ставит задачу в очередь и шлёт `NOTIFY jobs` (одним оператором, атомарно).
/// Возвращает `None`, если задача с таким `dedup_key` уже активна (queued/running).
pub async fn enqueue(
    db: impl PgExecutor<'_>,
    job: &Job,
    run_after: Option<DateTime<Utc>>,
) -> sqlx::Result<Option<i64>> {
    enqueue_with_attempts(db, job, run_after, None).await
}

/// То же, но со своим числом попыток (по умолчанию — 5).
pub async fn enqueue_with_attempts(
    db: impl PgExecutor<'_>,
    job: &Job,
    run_after: Option<DateTime<Utc>>,
    max_attempts: Option<i32>,
) -> sqlx::Result<Option<i64>> {
    let (kind, payload) = job.to_parts();
    sqlx::query_scalar(
        "WITH ins AS (
            INSERT INTO jobs (kind, payload, dedup_key, run_after, max_attempts)
            VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, 5))
            ON CONFLICT (dedup_key) WHERE state IN ('queued','running') DO NOTHING
            RETURNING id
         )
         SELECT ins.id FROM ins, LATERAL (SELECT pg_notify('jobs', ins.id::text)) n",
    )
    .bind(kind)
    .bind(payload)
    .bind(job.dedup_key())
    .bind(run_after)
    .bind(max_attempts)
    .fetch_optional(db)
    .await
}

/// Забирает следующую готовую задачу одного из видов `kinds` (`FOR UPDATE SKIP LOCKED`).
pub async fn claim(
    db: impl PgExecutor<'_>,
    worker_id: &str,
    kinds: &[&str],
) -> sqlx::Result<Option<JobRow>> {
    sqlx::query_as(
        "UPDATE jobs SET state = 'running', locked_at = now(), locked_by = $1,
                         attempts = attempts + 1, updated_at = now()
         WHERE id = (
            SELECT id FROM jobs
            WHERE state = 'queued' AND run_after <= now() AND kind = ANY($2)
            ORDER BY run_after, id
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING *",
    )
    .bind(worker_id)
    .bind(kinds)
    .fetch_optional(db)
    .await
}

pub async fn complete(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE jobs SET state = 'done', locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// Если задан `retry_at` и попытки не исчерпаны — задача возвращается в `queued`
/// с `run_after = retry_at`, иначе становится `failed`.
pub async fn fail(
    db: impl PgExecutor<'_>,
    id: i64,
    error: &str,
    retry_at: Option<DateTime<Utc>>,
) -> sqlx::Result<JobRow> {
    sqlx::query_as(
        "UPDATE jobs SET
            last_error = $2,
            state = CASE WHEN $3::timestamptz IS NOT NULL AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
            run_after = CASE WHEN $3::timestamptz IS NOT NULL AND attempts < max_attempts THEN $3 ELSE run_after END,
            locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(error)
    .bind(retry_at)
    .fetch_one(db)
    .await
}

/// Возвращает в очередь задачи, зависшие в `running` дольше `older_than` (процесс упал).
/// Если попытки исчерпаны, задача становится `failed` — иначе «ядовитая» задача, роняющая
/// процесс, перезапускалась бы бесконечно.
pub async fn requeue_stale(db: impl PgExecutor<'_>, older_than: Duration) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE jobs SET
            state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = CASE WHEN attempts >= max_attempts THEN 'worker lost; attempts exhausted' ELSE last_error END,
            locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE state = 'running' AND locked_at < now() - make_interval(secs => $1)",
    )
    .bind(older_than.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected())
}

/// Удаляет завершённые (`done`) задачи старше `older_than`.
pub async fn purge_done(db: impl PgExecutor<'_>, older_than: Duration) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM jobs WHERE state = 'done' AND updated_at < now() - make_interval(secs => $1)",
    )
    .bind(older_than.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected())
}

pub async fn list(
    db: impl PgExecutor<'_>,
    state: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<JobRow>> {
    sqlx::query_as(
        "SELECT * FROM jobs WHERE ($1::text IS NULL OR state = $1) ORDER BY id DESC LIMIT $2",
    )
    .bind(state)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Откладывает ожидающие `verify_torrent` альбома не раньше чем через `delay`
/// (резервные источники не должны мешать более важной работе).
pub async fn defer_queued_verifies(
    db: impl PgExecutor<'_>,
    album_id: i64,
    delay: Duration,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE jobs SET run_after = GREATEST(run_after, now() + make_interval(secs => $2)),
                         updated_at = now()
         WHERE kind = 'verify_torrent' AND state = 'queued' AND payload->>'album_id' = $1::text",
    )
    .bind(album_id)
    .bind(delay.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected())
}

/// Есть ли у альбома ожидающая (`queued`) задача `discover_album`.
pub async fn has_queued_discover(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM jobs WHERE state = 'queued' AND dedup_key = $1)",
    )
    .bind(format!("discover_album:{album_id}"))
    .fetch_one(db)
    .await
}
