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
