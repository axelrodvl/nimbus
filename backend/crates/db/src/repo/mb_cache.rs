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

/// Запись кэша вместе с признаком «просрочена».
#[derive(Debug, Clone, PartialEq)]
pub struct CacheEntry {
    pub value: Value,
    pub expired: bool,
}

/// Запись, в том числе просроченная (для stale-if-error: при отказе MusicBrainz лучше старый ответ, чем ошибка).
pub async fn get_entry(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<Option<CacheEntry>> {
    let row: Option<(Value, bool)> =
        sqlx::query_as("SELECT response, expires_at <= now() FROM mb_cache WHERE key = $1")
            .bind(key)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(value, expired)| CacheEntry { value, expired }))
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

/// Сколько просроченная запись остаётся пригодной как запасной ответ, прежде чем её удалят.
pub const STALE_GRACE: Duration = Duration::from_secs(30 * 24 * 3600);

/// Удаляет записи, просроченные дольше `grace`, возвращает их количество.
pub async fn purge_expired(db: impl PgExecutor<'_>, grace: Duration) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("DELETE FROM mb_cache WHERE expires_at <= now() - make_interval(secs => $1)")
            .bind(grace.as_secs_f64())
            .execute(db)
            .await?
            .rows_affected(),
    )
}
