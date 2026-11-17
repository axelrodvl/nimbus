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

/// Треки из `ids` в статусе `adding`/`not_found` → `found` одним запросом; возвращает изменённые.
pub async fn mark_found(db: impl PgExecutor<'_>, ids: &[i64]) -> sqlx::Result<Vec<Track>> {
    sqlx::query_as(
        "UPDATE tracks SET status = 'found', status_reason = NULL, updated_at = now()
         WHERE id = ANY($1) AND status IN ('adding', 'not_found')
         RETURNING *",
    )
    .bind(ids)
    .fetch_all(db)
    .await
}

/// Альбомы с треками библиотеки в `adding`, которые не менялись дольше `grace` и по которым нет
/// активного поиска (`discover_album` альбома или `discover_artist` его артиста). Такие альбомы
/// остались без исполнителя решения: поиск закончился, а финализация была отложена другим поиском.
pub async fn albums_stuck_in_adding(
    db: impl PgExecutor<'_>,
    grace: std::time::Duration,
) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT a.id FROM albums a
         WHERE EXISTS (
             SELECT 1 FROM tracks t
             WHERE t.album_id = a.id AND t.in_library AND t.status = 'adding'
               AND t.updated_at < now() - make_interval(secs => $1))
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.state IN ('queued', 'running')
               AND j.dedup_key IN ('discover_album:' || a.id, 'discover_artist:' || a.artist_id))
         ORDER BY a.id",
    )
    .bind(grace.as_secs_f64())
    .fetch_all(db)
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
            added_at = CASE WHEN $2 AND NOT in_library THEN now() WHEN $2 THEN COALESCE(added_at, now()) ELSE added_at END
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

/// `(mbid_recording, id, status, album_id)` для записей из `mbids`, находящихся в библиотеке
/// (если запись есть в нескольких альбомах — трек с наименьшим `id`).
pub async fn library_info_by_recording(
    db: impl PgExecutor<'_>,
    mbids: &[uuid::Uuid],
) -> sqlx::Result<Vec<(uuid::Uuid, i64, TrackStatus, i64)>> {
    sqlx::query_as(
        "SELECT DISTINCT ON (mbid_recording) mbid_recording, id, status, album_id
         FROM tracks WHERE mbid_recording = ANY($1) AND in_library
         ORDER BY mbid_recording, id",
    )
    .bind(mbids)
    .fetch_all(db)
    .await
}

/// Помечает все треки альбома; возвращает число изменённых строк.
pub async fn set_in_library_for_album(
    db: impl PgExecutor<'_>,
    album_id: i64,
    value: bool,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE tracks SET in_library = $2,
            added_at = CASE WHEN $2 AND NOT in_library THEN now() WHEN $2 THEN COALESCE(added_at, now()) ELSE added_at END
         WHERE album_id = $1 AND in_library IS DISTINCT FROM $2",
    )
    .bind(album_id)
    .bind(value)
    .execute(db)
    .await?
    .rows_affected())
}

/// Помечает все треки артиста (и треки его альбомов); возвращает число изменённых строк.
pub async fn set_in_library_for_artist(
    db: impl PgExecutor<'_>,
    artist_id: i64,
    value: bool,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE tracks SET in_library = $2,
            added_at = CASE WHEN $2 AND NOT in_library THEN now() WHEN $2 THEN COALESCE(added_at, now()) ELSE added_at END
         WHERE (artist_id = $1 OR album_id IN (SELECT id FROM albums WHERE artist_id = $1))
           AND in_library IS DISTINCT FROM $2",
    )
    .bind(artist_id)
    .bind(value)
    .execute(db)
    .await?
    .rows_affected())
}

/// Треки `found`, у которых primary-файл уже докачан, → `ready`; возвращает изменённые.
/// Штатно это делает наблюдатель загрузок в момент завершения файла; сюда попадают треки, чей
/// primary сменился на уже скачанный файл (смена источника при зависании, общий CUE-образ).
pub async fn promote_found_with_completed_file(
    db: impl PgExecutor<'_>,
) -> sqlx::Result<Vec<Track>> {
    sqlx::query_as(
        "UPDATE tracks t SET status = 'ready', status_reason = NULL, updated_at = now()
         WHERE t.status = 'found'
           AND EXISTS (SELECT 1 FROM track_sources ts
                         JOIN downloads d ON d.torrent_id = ts.torrent_id AND d.file_index = ts.file_index
                       WHERE ts.track_id = t.id AND ts.is_primary AND d.completed_at IS NOT NULL)
         RETURNING t.*",
    )
    .fetch_all(db)
    .await
}
