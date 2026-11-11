use nimbus_core::model::{Album, NewAlbum};
use sqlx::PgExecutor;

pub async fn upsert_by_rg_mbid(db: impl PgExecutor<'_>, a: &NewAlbum) -> sqlx::Result<Album> {
    sqlx::query_as(
        "INSERT INTO albums (mbid_release_group, mbid_release, artist_id, title, primary_type,
                             secondary_types, year, cover_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (mbid_release_group) DO UPDATE SET
            mbid_release = COALESCE(EXCLUDED.mbid_release, albums.mbid_release),
            artist_id = EXCLUDED.artist_id,
            title = EXCLUDED.title,
            primary_type = EXCLUDED.primary_type,
            secondary_types = EXCLUDED.secondary_types,
            year = EXCLUDED.year,
            cover_url = COALESCE(EXCLUDED.cover_url, albums.cover_url)
         RETURNING *",
    )
    .bind(a.mbid_release_group)
    .bind(a.mbid_release)
    .bind(a.artist_id)
    .bind(&a.title)
    .bind(&a.primary_type)
    .bind(&a.secondary_types)
    .bind(a.year)
    .bind(&a.cover_url)
    .fetch_one(db)
    .await
}

pub async fn get(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<Album>> {
    sqlx::query_as("SELECT * FROM albums WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn list_by_artist(db: impl PgExecutor<'_>, artist_id: i64) -> sqlx::Result<Vec<Album>> {
    sqlx::query_as("SELECT * FROM albums WHERE artist_id = $1 ORDER BY year NULLS LAST, id")
        .bind(artist_id)
        .fetch_all(db)
        .await
}

pub async fn set_in_library(
    db: impl PgExecutor<'_>,
    id: i64,
    value: bool,
) -> sqlx::Result<Option<Album>> {
    sqlx::query_as(
        "UPDATE albums SET in_library = $2,
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
    cursor: Option<i64>,
    limit: i64,
) -> sqlx::Result<Vec<Album>> {
    sqlx::query_as(
        "SELECT * FROM albums
         WHERE in_library AND ($1::bigint IS NULL OR id < $1)
         ORDER BY id DESC LIMIT $2",
    )
    .bind(cursor)
    .bind(limit)
    .fetch_all(db)
    .await
}
