use nimbus_core::model::{AlbumTorrent, RankedTorrent};
use sqlx::PgExecutor;

/// Связывает альбом и раздачу; при повторе сохраняется максимальный `rank_score`.
pub async fn link(
    db: impl PgExecutor<'_>,
    album_id: i64,
    torrent_id: i64,
    query: &str,
    rank_score: f32,
) -> sqlx::Result<AlbumTorrent> {
    sqlx::query_as(
        "INSERT INTO album_torrents (album_id, torrent_id, query, rank_score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (album_id, torrent_id) DO UPDATE SET
            rank_score = GREATEST(album_torrents.rank_score, EXCLUDED.rank_score)
         RETURNING *",
    )
    .bind(album_id)
    .bind(torrent_id)
    .bind(query)
    .bind(rank_score)
    .fetch_one(db)
    .await
}

pub async fn list_for_album(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<RankedTorrent>> {
    sqlx::query_as(
        "SELECT t.*, at.query AS link_query, at.rank_score, at.verified
         FROM album_torrents at JOIN torrents t ON t.id = at.torrent_id
         WHERE at.album_id = $1
         ORDER BY at.rank_score DESC, t.id",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}

pub async fn mark_verified(
    db: impl PgExecutor<'_>,
    album_id: i64,
    torrent_id: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE album_torrents SET verified = TRUE WHERE album_id = $1 AND torrent_id = $2",
    )
    .bind(album_id)
    .bind(torrent_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn count_unverified(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM album_torrents WHERE album_id = $1 AND NOT verified")
        .bind(album_id)
        .fetch_one(db)
        .await
}

/// (всего раздач у альбома, из них проверенных).
pub async fn progress(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<(i64, i64)> {
    sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE verified) FROM album_torrents WHERE album_id = $1",
    )
    .bind(album_id)
    .fetch_one(db)
    .await
}

/// Сводка по раздаче альбома (отладка и будущий публичный API источников).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct TorrentOverview {
    pub torrent_id: i64,
    pub title: String,
    pub source: nimbus_core::model::TorrentSource,
    pub kind: nimbus_core::model::TorrentKind,
    pub seeders: Option<i32>,
    pub meta_status: nimbus_core::model::MetaStatus,
    pub meta_attempts: i32,
    pub meta_error: Option<String>,
    pub rank_score: f32,
    pub verified: bool,
    pub files_count: i64,
    pub matched_tracks: i64,
}

pub async fn overview(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<TorrentOverview>> {
    sqlx::query_as(
        "SELECT t.id AS torrent_id, t.title, t.source, t.kind, t.seeders, t.meta_status,
                t.meta_attempts, t.meta_error, at.rank_score, at.verified,
                (SELECT count(*) FROM torrent_files f WHERE f.torrent_id = t.id) AS files_count,
                (SELECT count(DISTINCT ts.track_id) FROM track_sources ts
                   JOIN tracks tr ON tr.id = ts.track_id
                  WHERE ts.torrent_id = t.id AND tr.album_id = at.album_id) AS matched_tracks
         FROM album_torrents at JOIN torrents t ON t.id = at.torrent_id
         WHERE at.album_id = $1
         ORDER BY at.rank_score DESC, t.id",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}

/// Раздача альбома со счётчиками (публичный API источников).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AlbumTorrentRow {
    #[sqlx(flatten)]
    pub torrent: nimbus_core::model::Torrent,
    pub rank_score: f32,
    pub verified: bool,
    pub files_count: i64,
    pub matched_tracks: i64,
}

pub async fn list_with_counts(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Vec<AlbumTorrentRow>> {
    sqlx::query_as(
        "SELECT t.*, at.rank_score, at.verified,
                (SELECT count(*) FROM torrent_files f WHERE f.torrent_id = t.id) AS files_count,
                (SELECT count(DISTINCT ts.track_id) FROM track_sources ts
                   JOIN tracks tr ON tr.id = ts.track_id
                  WHERE ts.torrent_id = t.id AND tr.album_id = at.album_id) AS matched_tracks
         FROM album_torrents at JOIN torrents t ON t.id = at.torrent_id
         WHERE at.album_id = $1
         ORDER BY at.rank_score DESC, t.id",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}

/// Сбрасывает `verified` у раздач альбома с `meta_status = timeout` (дать шанс ещё раз).
pub async fn reset_verified_timeouts(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE album_torrents SET verified = FALSE
         WHERE album_id = $1 AND verified
           AND torrent_id IN (SELECT id FROM torrents WHERE meta_status = 'timeout')",
    )
    .bind(album_id)
    .execute(db)
    .await?
    .rows_affected())
}
