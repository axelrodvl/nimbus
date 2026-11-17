use std::collections::HashMap;

use sqlx::PgExecutor;

/// Записывает отдачу текущей сессии и возвращает накопленную (все сессии) по каждому info-hash.
///
/// Если значение сессии меньше записанного, движок перезапускался (или торрент добавили заново):
/// прошлая сессия переносится в накопленную сумму.
pub async fn record(
    db: impl PgExecutor<'_>,
    sessions: &[(String, u64)],
) -> sqlx::Result<HashMap<String, u64>> {
    if sessions.is_empty() {
        return Ok(HashMap::new());
    }
    let hashes: Vec<String> = sessions.iter().map(|(h, _)| h.clone()).collect();
    let bytes: Vec<i64> = sessions
        .iter()
        .map(|(_, b)| i64::try_from(*b).unwrap_or(i64::MAX))
        .collect();
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "INSERT INTO torrent_upload AS t (info_hash, session_bytes)
         SELECT * FROM unnest($1::text[], $2::bigint[])
         ON CONFLICT (info_hash) DO UPDATE SET
            uploaded_bytes = CASE WHEN EXCLUDED.session_bytes < t.session_bytes
                                  THEN t.uploaded_bytes + t.session_bytes
                                  ELSE t.uploaded_bytes END,
            session_bytes = EXCLUDED.session_bytes
         RETURNING info_hash, uploaded_bytes + session_bytes",
    )
    .bind(hashes)
    .bind(bytes)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(h, b)| (h, u64::try_from(b).unwrap_or(0)))
        .collect())
}
