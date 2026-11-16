use sqlx::PgExecutor;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, serde::Serialize)]
pub struct CueCandidateRow {
    pub torrent_id: i64,
    pub album_id: i64,
    pub cue_file_index: i32,
    pub image_file_index: i32,
    pub processed: bool,
}

/// Запоминает образ+cue; повтор обновляет индекс образа, но не сбрасывает `processed`.
pub async fn upsert(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    album_id: i64,
    cue_file_index: i32,
    image_file_index: i32,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO cue_candidates (torrent_id, album_id, cue_file_index, image_file_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (torrent_id, album_id, cue_file_index) DO UPDATE SET
            image_file_index = EXCLUDED.image_file_index",
    )
    .bind(torrent_id)
    .bind(album_id)
    .bind(cue_file_index)
    .bind(image_file_index)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn list_for_album(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<CueCandidateRow>> {
    sqlx::query_as(
        "SELECT * FROM cue_candidates WHERE album_id = $1 ORDER BY torrent_id, cue_file_index",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}

pub async fn get(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    album_id: i64,
    cue_file_index: i32,
) -> sqlx::Result<Option<CueCandidateRow>> {
    sqlx::query_as(
        "SELECT * FROM cue_candidates WHERE torrent_id = $1 AND album_id = $2 AND cue_file_index = $3",
    )
    .bind(torrent_id)
    .bind(album_id)
    .bind(cue_file_index)
    .fetch_optional(db)
    .await
}

pub async fn mark_processed(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    album_id: i64,
    cue_file_index: i32,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE cue_candidates SET processed = TRUE
         WHERE torrent_id = $1 AND album_id = $2 AND cue_file_index = $3",
    )
    .bind(torrent_id)
    .bind(album_id)
    .bind(cue_file_index)
    .execute(db)
    .await?;
    Ok(())
}

/// Сколько CUE-образов альбома ещё не разобрано (финализация альбома ждёт их).
pub async fn count_pending(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM cue_candidates WHERE album_id = $1 AND NOT processed")
        .bind(album_id)
        .fetch_one(db)
        .await
}

/// Неразобранные CUE-образы альбома `(torrent_id, cue_file_index)`, для которых нет активной задачи
/// `process_cue`. Непустой результат у альбома без поиска — дыра: задачу потеряли.
pub async fn pending_without_job(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<(i64, i32)>> {
    sqlx::query_as(
        "SELECT c.torrent_id, c.cue_file_index FROM cue_candidates c
         WHERE c.album_id = $1 AND NOT c.processed
           AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.state IN ('queued','running')
                             AND j.dedup_key = 'process_cue:' || c.torrent_id || ':' || c.album_id
                                               || ':' || c.cue_file_index)
         ORDER BY c.torrent_id, c.cue_file_index",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}
