use std::time::Duration;

use serde_json::Value;
use sqlx::PgExecutor;

/// Возвращает значение, только если оно не истекло.
pub async fn get(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("SELECT response FROM mb_cache WHERE key = $1 AND expires_at > now()")
        .bind(key)
        .fetch_optional(db)
        .await
}

pub async fn put(
    db: impl PgExecutor<'_>,
    key: &str,
    value: &Value,
    ttl: Duration,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO mb_cache (key, response, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at",
    )
    .bind(key)
    .bind(value)
    .bind(ttl.as_secs_f64())
    .execute(db)
    .await?;
    Ok(())
}

/// Удаляет истёкшие записи, возвращает их количество.
pub async fn purge_expired(db: impl PgExecutor<'_>) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("DELETE FROM mb_cache WHERE expires_at <= now()")
            .execute(db)
            .await?
            .rows_affected(),
    )
}
