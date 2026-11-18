//! Кэш ответов MusicBrainz (и ListenBrainz, картинок артистов). Записи никогда не удаляются сами: просроченная
//! отдаётся сразу и обновляется в фоне. Каждое чтение отмечает `last_used_at` (не чаще раза в час на запись) —
//! задел под LRU, если кэш когда-нибудь разрастётся.

use std::time::Duration;

use serde_json::Value;
use sqlx::PgExecutor;

/// Чтение отмечает использование, но пишет не чаще раза в час на запись (без лишней записи на каждый поиск).
const TOUCH: &str = "touch AS (
        UPDATE mb_cache m SET last_used_at = now() FROM hit
        WHERE m.key = hit.key AND hit.last_used_at < now() - interval '1 hour')";

/// Возвращает значение, только если оно не истекло.
pub async fn get(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(&format!(
        "WITH hit AS (SELECT key, response, last_used_at FROM mb_cache WHERE key = $1 AND expires_at > now()),
         {TOUCH}
         SELECT response FROM hit"
    ))
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
    let row: Option<(Value, bool)> = sqlx::query_as(&format!(
        "WITH hit AS (SELECT key, response, expires_at <= now() AS expired, last_used_at FROM mb_cache WHERE key = $1),
         {TOUCH}
         SELECT response, expired FROM hit"
    ))
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
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at,
             last_used_at = now()",
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
    let rows: Vec<(String, Value)> = sqlx::query_as(&format!(
        "WITH hit AS (SELECT key, response, last_used_at FROM mb_cache WHERE key = ANY($1) AND expires_at > now()),
         {TOUCH}
         SELECT key, response FROM hit"
    ))
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
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at,
             last_used_at = now()",
    )
    .bind(keys)
    .bind(values)
    .bind(ttl.as_secs_f64())
    .execute(db)
    .await?;
    Ok(())
}
