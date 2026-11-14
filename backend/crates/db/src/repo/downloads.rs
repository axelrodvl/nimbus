use nimbus_core::model::{Download, NewDownload};
use sqlx::PgExecutor;

pub async fn upsert(db: impl PgExecutor<'_>, d: &NewDownload) -> sqlx::Result<Download> {
    sqlx::query_as(
        "INSERT INTO downloads (torrent_id, file_index, local_path, bytes_total, bytes_done)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (torrent_id, file_index) DO UPDATE SET
            local_path = EXCLUDED.local_path,
            bytes_total = EXCLUDED.bytes_total,
            bytes_done = EXCLUDED.bytes_done
         RETURNING *",
    )
    .bind(d.torrent_id)
    .bind(d.file_index)
    .bind(&d.local_path)
    .bind(d.bytes_total)
    .bind(d.bytes_done)
    .fetch_one(db)
    .await
}

pub async fn get(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
) -> sqlx::Result<Option<Download>> {
    sqlx::query_as("SELECT * FROM downloads WHERE torrent_id = $1 AND file_index = $2")
        .bind(torrent_id)
        .bind(file_index)
        .fetch_optional(db)
        .await
}

pub async fn mark_completed(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
) -> sqlx::Result<Option<Download>> {
    sqlx::query_as(
        "UPDATE downloads SET bytes_done = bytes_total, completed_at = COALESCE(completed_at, now())
         WHERE torrent_id = $1 AND file_index = $2 RETURNING *",
    )
    .bind(torrent_id)
    .bind(file_index)
    .fetch_optional(db)
    .await
}

pub async fn touch_played(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE downloads SET last_played_at = now() WHERE torrent_id = $1 AND file_index = $2",
    )
    .bind(torrent_id)
    .bind(file_index)
    .execute(db)
    .await?;
    Ok(())
}

/// Незавершённые загрузки (для наблюдателя прогресса).
pub async fn list_active(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<Download>> {
    sqlx::query_as(
        "SELECT * FROM downloads WHERE completed_at IS NULL ORDER BY torrent_id, file_index",
    )
    .fetch_all(db)
    .await
}

/// Незавершённая загрузка вместе с `info_hash` торрента (для наблюдателя: без запроса на каждую строку).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActiveDownload {
    pub torrent_id: i64,
    pub file_index: i32,
    pub info_hash: String,
}

/// Незавершённые загрузки с `info_hash` одним запросом.
pub async fn list_active_with_hash(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<ActiveDownload>> {
    sqlx::query_as(
        "SELECT d.torrent_id, d.file_index, t.info_hash
         FROM downloads d JOIN torrents t ON t.id = d.torrent_id
         WHERE d.completed_at IS NULL ORDER BY d.torrent_id, d.file_index",
    )
    .fetch_all(db)
    .await
}

/// Завершённые загрузки (для проверки наличия файлов при старте).
pub async fn list_completed(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<Download>> {
    sqlx::query_as(
        "SELECT * FROM downloads WHERE completed_at IS NOT NULL ORDER BY torrent_id, file_index",
    )
    .fetch_all(db)
    .await
}

pub async fn update_progress(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
    bytes_done: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE downloads SET bytes_done = $3 WHERE torrent_id = $1 AND file_index = $2 AND completed_at IS NULL",
    )
    .bind(torrent_id)
    .bind(file_index)
    .bind(bytes_done)
    .execute(db)
    .await?;
    Ok(())
}

/// Файл пропал с диска: загрузка снова считается незавершённой.
pub async fn reset_completed(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE downloads SET completed_at = NULL, bytes_done = 0 WHERE torrent_id = $1 AND file_index = $2",
    )
    .bind(torrent_id)
    .bind(file_index)
    .execute(db)
    .await?;
    Ok(())
}

/// Все загрузки (для учёта места и вытеснения кэша).
pub async fn list_all(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<Download>> {
    sqlx::query_as("SELECT * FROM downloads ORDER BY torrent_id, file_index")
        .fetch_all(db)
        .await
}

pub async fn delete(db: impl PgExecutor<'_>, torrent_id: i64, file_index: i32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM downloads WHERE torrent_id = $1 AND file_index = $2")
        .bind(torrent_id)
        .bind(file_index)
        .execute(db)
        .await?;
    Ok(())
}

/// Строки `downloads` для набора файлов `(torrent_id, file_index)` одним запросом.
pub async fn get_many(
    db: impl PgExecutor<'_>,
    files: &[(i64, i32)],
) -> sqlx::Result<Vec<Download>> {
    if files.is_empty() {
        return Ok(vec![]);
    }
    let (torrents, indexes): (Vec<i64>, Vec<i32>) = files.iter().copied().unzip();
    sqlx::query_as(
        "SELECT d.* FROM unnest($1::bigint[], $2::int[]) AS f(torrent_id, file_index)
         JOIN downloads d ON d.torrent_id = f.torrent_id AND d.file_index = f.file_index",
    )
    .bind(torrents)
    .bind(indexes)
    .fetch_all(db)
    .await
}
