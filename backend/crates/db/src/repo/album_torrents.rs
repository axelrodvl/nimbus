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
