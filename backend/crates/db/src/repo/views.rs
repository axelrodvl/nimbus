//! Представления для API чтения: сущности вместе с агрегатами и связанными именами.

use chrono::{DateTime, Utc};
use nimbus_core::model::{Track, TrackStatus};
use sqlx::PgExecutor;
use uuid::Uuid;

/// Курсор keyset-пагинации: `(added_at, id)` последней записи страницы (порядок — по убыванию).
pub type Cursor = (DateTime<Utc>, i64);

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ArtistView {
    pub id: i64,
    pub mbid: Uuid,
    pub name: String,
    pub disambiguation: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    /// Альбомы артиста, в которых хоть что-то в библиотеке.
    pub album_count: i64,
    /// Треки артиста в библиотеке.
    pub track_count: i64,
    /// Последняя задача импорта дискографии (`jobs.state`): `queued` / `running` / `done` / `failed`.
    pub import_state: Option<String>,
    pub import_attempts: Option<i32>,
    pub import_max_attempts: Option<i32>,
    pub import_run_after: Option<DateTime<Utc>>,
    pub import_error: Option<String>,
    pub import_progress: Option<serde_json::Value>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AlbumView {
    pub id: i64,
    pub mbid: Uuid,
    pub title: String,
    pub artist_id: i64,
    pub artist_name: String,
    pub year: Option<i32>,
    pub primary_type: Option<String>,
    pub cover_url: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    /// Все треки альбома (не только в библиотеке).
    pub track_count: i64,
    pub adding: i64,
    pub found: i64,
    pub not_found: i64,
    pub ready: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrackView {
    pub id: i64,
    pub mbid_recording: Uuid,
    pub title: String,
    pub album_id: i64,
    pub album_title: String,
    pub artist_id: i64,
    pub artist_name: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
    pub cover_url: Option<String>,
    pub status: TrackStatus,
    pub status_reason: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    /// Primary-источник трека требует подтверждения.
    pub needs_confirmation: bool,
    /// Primary-источник нужно перекодировать (CUE-образ или формат, который не играет браузер).
    pub transcode: bool,
}

const ARTIST_SELECT: &str = "
    SELECT a.id, a.mbid, a.name, a.disambiguation, a.in_library, a.added_at,
      (SELECT count(*) FROM albums al WHERE al.artist_id = a.id
         AND (al.in_library OR EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.in_library))) AS album_count,
      (SELECT count(*) FROM tracks t WHERE t.in_library
         AND (t.artist_id = a.id OR t.album_id IN (SELECT id FROM albums WHERE artist_id = a.id))) AS track_count,
      ij.state AS import_state, ij.attempts AS import_attempts, ij.max_attempts AS import_max_attempts,
      ij.run_after AS import_run_after, ij.last_error AS import_error,
      ij.progress AS import_progress
    FROM artists a
    LEFT JOIN LATERAL (
      SELECT j.state, j.attempts, j.max_attempts, j.run_after, j.last_error, j.progress FROM jobs j
       WHERE j.kind = 'import_artist' AND j.payload->>'artist_id' = a.id::text
       ORDER BY j.id DESC LIMIT 1) ij ON TRUE";

const ALBUM_SELECT: &str = "
    SELECT al.id, al.mbid_release_group AS mbid, al.title, al.artist_id, ar.name AS artist_name,
           al.year, al.primary_type, al.cover_url, al.in_library, al.added_at,
           count(t.id) AS track_count,
           count(t.id) FILTER (WHERE t.status = 'adding') AS adding,
           count(t.id) FILTER (WHERE t.status = 'found') AS found,
           count(t.id) FILTER (WHERE t.status = 'not_found') AS not_found,
           count(t.id) FILTER (WHERE t.status = 'ready') AS ready
    FROM albums al
    JOIN artists ar ON ar.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id";

const ALBUM_GROUP: &str = " GROUP BY al.id, ar.name";

const TRACK_SELECT: &str = "
    SELECT t.id, t.mbid_recording, t.title, t.album_id, al.title AS album_title, t.artist_id,
           ar.name AS artist_name, t.disc_no, t.position, t.duration_ms, al.cover_url,
           t.status, t.status_reason, t.in_library, t.added_at,
           EXISTS (SELECT 1 FROM track_sources ts
                    WHERE ts.track_id = t.id AND ts.is_primary AND ts.needs_confirmation) AS needs_confirmation,
           COALESCE((SELECT ts.cue_start_ms IS NOT NULL
                            OR lower(COALESCE(f.ext, '')) NOT IN ('flac','mp3','m4a','aac','alac','ogg','opus','wav')
                       FROM track_sources ts
                       JOIN torrent_files f ON f.torrent_id = ts.torrent_id AND f.file_index = ts.file_index
                      WHERE ts.track_id = t.id AND ts.is_primary), FALSE) AS transcode
    FROM tracks t
    JOIN albums al ON al.id = t.album_id
    JOIN artists ar ON ar.id = t.artist_id";

fn split(cursor: Option<Cursor>) -> (Option<DateTime<Utc>>, Option<i64>) {
    (cursor.map(|c| c.0), cursor.map(|c| c.1))
}

/// Пустой список — без фильтра по статусу.
fn status_filter(statuses: &[TrackStatus]) -> Option<Vec<&str>> {
    (!statuses.is_empty()).then(|| statuses.iter().map(|s| s.as_str()).collect())
}

/// Артисты библиотеки; с `statuses` — только те, у кого есть трек библиотеки с таким статусом.
pub async fn list_artists(
    db: impl PgExecutor<'_>,
    statuses: &[TrackStatus],
    cursor: Option<Cursor>,
    limit: i64,
) -> sqlx::Result<Vec<ArtistView>> {
    let (at, id) = split(cursor);
    sqlx::query_as(&format!(
        "{ARTIST_SELECT} WHERE a.in_library
           AND ($1::text[] IS NULL OR EXISTS (
                 SELECT 1 FROM tracks t WHERE t.in_library AND t.status = ANY($1)
                   AND (t.artist_id = a.id OR t.album_id IN (SELECT id FROM albums WHERE artist_id = a.id))))
           AND ($2::timestamptz IS NULL OR (a.added_at, a.id) < ($2, $3))
         ORDER BY a.added_at DESC, a.id DESC LIMIT $4"
    ))
    .bind(status_filter(statuses))
    .bind(at)
    .bind(id)
    .bind(limit)
    .fetch_all(db)
    .await
}

pub async fn get_artist(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<ArtistView>> {
    sqlx::query_as(&format!("{ARTIST_SELECT} WHERE a.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

/// Альбомы библиотеки: добавленные целиком и те, где в библиотеке есть хотя бы один трек.
/// `added_at` — самая поздняя дата добавления альбома или его трека (по ней сортировка и курсор).
pub async fn list_albums(
    db: impl PgExecutor<'_>,
    statuses: &[TrackStatus],
    cursor: Option<Cursor>,
    limit: i64,
) -> sqlx::Result<Vec<AlbumView>> {
    let (at, id) = split(cursor);
    let select = ALBUM_SELECT.replace(
        "al.in_library, al.added_at,",
        "al.in_library, GREATEST(al.added_at, max(t.added_at) FILTER (WHERE t.in_library)) AS added_at,",
    );
    sqlx::query_as(&format!(
        "SELECT * FROM ({select}
           WHERE al.in_library OR EXISTS (SELECT 1 FROM tracks it WHERE it.album_id = al.id AND it.in_library)
           {ALBUM_GROUP}) x
         WHERE ($1::text[] IS NULL OR EXISTS (
                 SELECT 1 FROM tracks ft WHERE ft.album_id = x.id AND ft.in_library AND ft.status = ANY($1)))
           AND ($2::timestamptz IS NULL OR (x.added_at, x.id) < ($2, $3))
         ORDER BY x.added_at DESC, x.id DESC LIMIT $4"
    ))
    .bind(status_filter(statuses))
    .bind(at)
    .bind(id)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Недавно проигранные альбомы (по `downloads.last_played_at` primary-источников), свежие первыми.
/// `added_at` в результате — время последнего проигрывания.
pub async fn recently_played_albums(
    db: impl PgExecutor<'_>,
    limit: i64,
) -> sqlx::Result<Vec<AlbumView>> {
    let select = ALBUM_SELECT.replace(
        "al.in_library, al.added_at,",
        "al.in_library, p.played_at AS added_at,",
    );
    sqlx::query_as(&format!(
        "{select}
         JOIN (SELECT pt.album_id, max(d.last_played_at) AS played_at
                 FROM downloads d
                 JOIN track_sources ts ON ts.torrent_id = d.torrent_id AND ts.file_index = d.file_index AND ts.is_primary
                 JOIN tracks pt ON pt.id = ts.track_id
                WHERE d.last_played_at IS NOT NULL
                GROUP BY pt.album_id) p ON p.album_id = al.id
         GROUP BY al.id, ar.name, p.played_at
         ORDER BY p.played_at DESC, al.id DESC LIMIT $1"
    ))
    .bind(limit)
    .fetch_all(db)
    .await
}

pub async fn get_album(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<AlbumView>> {
    sqlx::query_as(&format!("{ALBUM_SELECT} WHERE al.id = $1{ALBUM_GROUP}"))
        .bind(id)
        .fetch_optional(db)
        .await
}

/// Альбомы артиста, в которых хоть что-то в библиотеке (по году, затем id).
pub async fn albums_for_artist(
    db: impl PgExecutor<'_>,
    artist_id: i64,
) -> sqlx::Result<Vec<AlbumView>> {
    sqlx::query_as(&format!(
        "{ALBUM_SELECT} WHERE al.artist_id = $1
           AND (al.in_library OR EXISTS (SELECT 1 FROM tracks x WHERE x.album_id = al.id AND x.in_library))
         {ALBUM_GROUP} ORDER BY al.year NULLS LAST, al.id"
    ))
    .bind(artist_id)
    .fetch_all(db)
    .await
}

pub async fn list_tracks(
    db: impl PgExecutor<'_>,
    statuses: &[TrackStatus],
    cursor: Option<Cursor>,
    limit: i64,
) -> sqlx::Result<Vec<TrackView>> {
    let (at, id) = split(cursor);
    sqlx::query_as(&format!(
        "{TRACK_SELECT} WHERE t.in_library AND ($1::text[] IS NULL OR t.status = ANY($1))
           AND ($2::timestamptz IS NULL OR (t.added_at, t.id) < ($2, $3))
         ORDER BY t.added_at DESC, t.id DESC LIMIT $4"
    ))
    .bind(status_filter(statuses))
    .bind(at)
    .bind(id)
    .bind(limit)
    .fetch_all(db)
    .await
}

pub async fn get_track(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<TrackView>> {
    sqlx::query_as(&format!("{TRACK_SELECT} WHERE t.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

/// Все треки альбома по `disc_no, position` (с флагом `in_library`).
pub async fn tracks_for_album(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<TrackView>> {
    sqlx::query_as(&format!(
        "{TRACK_SELECT} WHERE t.album_id = $1 ORDER BY t.disc_no, t.position"
    ))
    .bind(album_id)
    .fetch_all(db)
    .await
}

/// Курсор следующей страницы по последней записи.
pub fn next_cursor(added_at: Option<DateTime<Utc>>, id: i64) -> Option<Cursor> {
    added_at.map(|a| (a, id))
}

// Тип `Track` реэкспортируется для удобства потребителей репозитория.
pub type TrackRow = Track;
