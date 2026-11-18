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

/// Несколько непросроченных записей разом: ключ → значение (отсутствующих в карте нет).
pub async fn get_many(
    db: impl PgExecutor<'_>,
    keys: &[String],
) -> sqlx::Result<std::collections::HashMap<String, Value>> {
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT key, response FROM mb_cache WHERE key = ANY($1) AND expires_at > now()",
    )
    .bind(keys)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Несколько записей одним запросом (upsert).
pub async fn put_many(
    db: impl PgExecutor<'_>,
    rows: &[(String, Value)],
    ttl: Duration,
) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (keys, values): (Vec<&str>, Vec<&Value>) =
        rows.iter().map(|(k, v)| (k.as_str(), v)).unzip();
    sqlx::query(
        "INSERT INTO mb_cache (key, response, expires_at)
         SELECT k, v, now() + make_interval(secs => $3) FROM unnest($1::text[], $2::jsonb[]) AS t(k, v)
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at",
    )
    .bind(keys)
    .bind(values)
    .bind(ttl.as_secs_f64())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM mb_cache WHERE key = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

/// Сколько просроченная запись хранится (её отдают сразу и обновляют в фоне, а при отказе MusicBrainz — вместо
/// ошибки), прежде чем её удалят: год — повторный поиск не ждёт MusicBrainz, даже если был давно.
pub const STALE_GRACE: Duration = Duration::from_secs(365 * 24 * 3600);

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
