//! Плейлисты и счётчик прослушиваний.

use chrono::{DateTime, Utc};
use sqlx::PgExecutor;

/// Размер динамического плейлиста Favorites.
pub const FAVORITES_LIMIT: i64 = 100;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PlaylistRow {
    pub id: i64,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub track_count: i64,
    /// Обложка первого трека (альбом).
    pub cover_url: Option<String>,
}

const PLAYLIST_SELECT: &str = "
    SELECT p.id, p.name, p.created_at, p.last_used_at,
           (SELECT count(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
           (SELECT al.cover_url FROM playlist_tracks pt
              JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id
             WHERE pt.playlist_id = p.id AND al.cover_url IS NOT NULL
             ORDER BY pt.id LIMIT 1) AS cover_url
    FROM playlists p";

/// Плейлисты: недавно использованные первыми.
pub async fn list(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<PlaylistRow>> {
    sqlx::query_as(&format!(
        "{PLAYLIST_SELECT} ORDER BY p.last_used_at DESC, p.id DESC"
    ))
    .fetch_all(db)
    .await
}

pub async fn get(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<PlaylistRow>> {
    sqlx::query_as(&format!("{PLAYLIST_SELECT} WHERE p.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn create(db: impl PgExecutor<'_>, name: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("INSERT INTO playlists (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_one(db)
        .await
}

/// `true`, если плейлист существовал.
pub async fn delete(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query("DELETE FROM playlists WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected()
        > 0)
}

/// Добавляет трек (повтор — не дублирует) и поднимает плейлист наверх списка.
/// `false` — плейлиста или трека нет.
pub async fn add_track(
    db: impl PgExecutor<'_>,
    playlist_id: i64,
    track_id: i64,
) -> sqlx::Result<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "WITH p AS (
             UPDATE playlists SET last_used_at = now()
              WHERE id = $1 AND EXISTS (SELECT 1 FROM tracks WHERE id = $2)
             RETURNING id)
         INSERT INTO playlist_tracks (playlist_id, track_id)
         SELECT id, $2 FROM p
         ON CONFLICT (playlist_id, track_id) DO UPDATE SET playlist_id = EXCLUDED.playlist_id
         RETURNING id",
    )
    .bind(playlist_id)
    .bind(track_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

pub async fn remove_track(
    db: impl PgExecutor<'_>,
    playlist_id: i64,
    track_id: i64,
) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2")
            .bind(playlist_id)
            .bind(track_id)
            .execute(db)
            .await?
            .rows_affected()
            > 0,
    )
}

/// Сколько треков сейчас в Favorites.
pub async fn favorites_count(db: impl PgExecutor<'_>) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT least(count(*), $1) FROM track_plays WHERE play_count > 0")
        .bind(FAVORITES_LIMIT)
        .fetch_one(db)
        .await
}

/// Обложка самого прослушиваемого трека.
pub async fn favorites_cover(db: impl PgExecutor<'_>) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        "SELECT al.cover_url FROM track_plays tp
           JOIN tracks t ON t.id = tp.track_id JOIN albums al ON al.id = t.album_id
          WHERE tp.play_count > 0 AND al.cover_url IS NOT NULL
          ORDER BY tp.play_count DESC, tp.last_played_at DESC LIMIT 1",
    )
    .fetch_optional(db)
    .await
}

/// Засчитывает прослушивание; возвращает новый счётчик (`None` — трека нет).
pub async fn record_play(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        "INSERT INTO track_plays (track_id, play_count, last_played_at)
         SELECT id, 1, now() FROM tracks WHERE id = $1
         ON CONFLICT (track_id) DO UPDATE
            SET play_count = track_plays.play_count + 1, last_played_at = now()
         RETURNING play_count",
    )
    .bind(track_id)
    .fetch_optional(db)
    .await
}
