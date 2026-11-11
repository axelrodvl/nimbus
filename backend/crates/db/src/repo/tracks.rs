use nimbus_core::model::{NewTrack, NotFoundReason, Track, TrackFilter, TrackStatus};
use sqlx::PgExecutor;

/// Upsert по `mbid_track`. При конфликте `status`/`status_reason`/`in_library` не меняются.
pub async fn upsert_by_mbid_track(db: impl PgExecutor<'_>, t: &NewTrack) -> sqlx::Result<Track> {
    sqlx::query_as(
        "INSERT INTO tracks (mbid_recording, mbid_track, album_id, artist_id, title, disc_no, position, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (mbid_track) DO UPDATE SET
            mbid_recording = EXCLUDED.mbid_recording,
            album_id = EXCLUDED.album_id,
            artist_id = EXCLUDED.artist_id,
            title = EXCLUDED.title,
            disc_no = EXCLUDED.disc_no,
            position = EXCLUDED.position,
            duration_ms = EXCLUDED.duration_ms
         RETURNING *",
    )
    .bind(t.mbid_recording)
    .bind(t.mbid_track)
    .bind(t.album_id)
    .bind(t.artist_id)
    .bind(&t.title)
    .bind(t.disc_no)
    .bind(t.position)
    .bind(t.duration_ms)
    .fetch_one(db)
    .await
}

pub async fn get(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<Track>> {
    sqlx::query_as("SELECT * FROM tracks WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn list_by_album(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<Vec<Track>> {
    sqlx::query_as("SELECT * FROM tracks WHERE album_id = $1 ORDER BY disc_no, position")
        .bind(album_id)
        .fetch_all(db)
        .await
}

pub async fn set_status(
    db: impl PgExecutor<'_>,
    id: i64,
    status: TrackStatus,
    reason: Option<NotFoundReason>,
) -> sqlx::Result<Track> {
    sqlx::query_as(
        "UPDATE tracks SET status = $2, status_reason = $3, updated_at = now()
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(status)
    .bind(reason)
    .fetch_one(db)
    .await
}

/// Переводит треки альбома из любого статуса в `from` в статус `to`; возвращает изменённые.
pub async fn set_status_for_album(
    db: impl PgExecutor<'_>,
    album_id: i64,
    from: &[TrackStatus],
    to: TrackStatus,
    reason: Option<NotFoundReason>,
) -> sqlx::Result<Vec<Track>> {
    let from: Vec<&str> = from.iter().map(|s| s.as_str()).collect();
    sqlx::query_as(
        "UPDATE tracks SET status = $3, status_reason = $4, updated_at = now()
         WHERE album_id = $1 AND status = ANY($2)
         RETURNING *",
    )
    .bind(album_id)
    .bind(from)
    .bind(to)
    .bind(reason)
    .fetch_all(db)
    .await
}

pub async fn set_in_library(
    db: impl PgExecutor<'_>,
    id: i64,
    value: bool,
) -> sqlx::Result<Option<Track>> {
    sqlx::query_as(
        "UPDATE tracks SET in_library = $2,
            added_at = CASE WHEN $2 THEN COALESCE(added_at, now()) ELSE added_at END
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(value)
    .fetch_optional(db)
    .await
}

pub async fn list_in_library(
    db: impl PgExecutor<'_>,
    filter: &TrackFilter,
    cursor: Option<i64>,
    limit: i64,
) -> sqlx::Result<Vec<Track>> {
    sqlx::query_as(
        "SELECT * FROM tracks
         WHERE in_library
           AND ($1::text IS NULL OR status = $1)
           AND ($2::bigint IS NULL OR id < $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(filter.status)
    .bind(cursor)
    .bind(limit)
    .fetch_all(db)
    .await
}
