use nimbus_core::model::{Artist, NewArtist};
use sqlx::PgExecutor;
use uuid::Uuid;

pub async fn upsert_by_mbid(db: impl PgExecutor<'_>, a: &NewArtist) -> sqlx::Result<Artist> {
    sqlx::query_as(
        "INSERT INTO artists (mbid, name, sort_name, disambiguation)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mbid) DO UPDATE SET
            name = EXCLUDED.name,
            sort_name = EXCLUDED.sort_name,
            disambiguation = EXCLUDED.disambiguation
         RETURNING *",
    )
    .bind(a.mbid)
    .bind(&a.name)
    .bind(&a.sort_name)
    .bind(&a.disambiguation)
    .fetch_one(db)
    .await
}

pub async fn get(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<Artist>> {
    sqlx::query_as("SELECT * FROM artists WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn get_by_mbid(db: impl PgExecutor<'_>, mbid: Uuid) -> sqlx::Result<Option<Artist>> {
    sqlx::query_as("SELECT * FROM artists WHERE mbid = $1")
        .bind(mbid)
        .fetch_optional(db)
        .await
}

pub async fn set_in_library(
    db: impl PgExecutor<'_>,
    id: i64,
    value: bool,
) -> sqlx::Result<Option<Artist>> {
    sqlx::query_as(
        "UPDATE artists SET in_library = $2,
            added_at = CASE WHEN $2 AND NOT in_library THEN now() WHEN $2 THEN COALESCE(added_at, now()) ELSE added_at END
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(value)
    .fetch_optional(db)
    .await
}

/// Курсор — последний `id` предыдущей страницы (порядок `id DESC`).
pub async fn list_in_library(
    db: impl PgExecutor<'_>,
    cursor: Option<i64>,
    limit: i64,
) -> sqlx::Result<Vec<Artist>> {
    sqlx::query_as(
        "SELECT * FROM artists
         WHERE in_library AND ($1::bigint IS NULL OR id < $1)
         ORDER BY id DESC LIMIT $2",
    )
    .bind(cursor)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Идентификаторы всех артистов библиотеки.
pub async fn library_artist_ids(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT id FROM artists WHERE in_library ORDER BY id")
        .fetch_all(db)
        .await
}

/// `(mbid, id)` для артистов из `mbids`, которые находятся в библиотеке.
pub async fn library_ids_by_mbid(
    db: impl PgExecutor<'_>,
    mbids: &[Uuid],
) -> sqlx::Result<Vec<(Uuid, i64)>> {
    sqlx::query_as("SELECT mbid, id FROM artists WHERE mbid = ANY($1) AND in_library")
        .bind(mbids)
        .fetch_all(db)
        .await
}
