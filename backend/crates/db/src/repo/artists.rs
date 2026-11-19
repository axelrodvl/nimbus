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

/// Артисты библиотеки без единого альбома, добавленные больше `grace` назад, у которых нет
/// задачи `import_artist` в состояниях `queued`/`running`/`done`/`failed` (упавшую оживляет
/// отдельный механизм). Это страховка от потерянной постановки импорта.
pub async fn without_import(
    db: impl PgExecutor<'_>,
    grace: std::time::Duration,
) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT a.id FROM artists a
         WHERE a.in_library
           AND a.added_at < now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.dedup_key = 'import_artist:' || a.id
                             AND j.state IN ('queued', 'running', 'done', 'failed'))
         ORDER BY a.id",
    )
    .bind(grace.as_secs_f64())
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

/// Записывает признак фото артиста (`'yes'`/`'no'`); `None` — «ещё не искали». Строка не трогается
/// (и не попадает в дельту синхронизации), если значение уже такое. Возвращает, изменилась ли строка.
pub async fn set_image(
    db: impl PgExecutor<'_>,
    mbid: Uuid,
    image: Option<bool>,
) -> sqlx::Result<bool> {
    let value = image.map(|y| if y { "yes" } else { "no" });
    let res =
        sqlx::query("UPDATE artists SET image = $2 WHERE mbid = $1 AND image IS DISTINCT FROM $2")
            .bind(mbid)
            .bind(value)
            .execute(db)
            .await?;
    Ok(res.rows_affected() > 0)
}

/// Сбрасывает `'no'` в «не искали» у артистов, чей отрицательный ответ в `mb_cache` истёк
/// (`MISS_TTL`): фото могло появиться. Возвращает число сброшенных.
pub async fn reset_expired_no_image(db: impl PgExecutor<'_>) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "UPDATE artists a SET image = NULL
         WHERE a.image = 'no'
           AND EXISTS (SELECT 1 FROM mb_cache m
                       WHERE m.key = 'artist_image:' || a.mbid AND m.expires_at <= now())",
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// Артисты библиотеки, у которых фото ещё не искали и нет ни активной задачи `fetch_artist_image`,
/// ни недавней (`retry_after` — пауза после упавшей, чтобы постоянный отказ не крутился каждую минуту).
pub async fn without_image_job(
    db: impl PgExecutor<'_>,
    retry_after: std::time::Duration,
    limit: i64,
) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT a.id FROM artists a
         WHERE a.in_library AND a.image IS NULL
           AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.dedup_key = 'fetch_artist_image:' || a.id
                             AND (j.state IN ('queued', 'running')
                                  OR j.updated_at > now() - make_interval(secs => $1)))
         ORDER BY a.id LIMIT $2",
    )
    .bind(retry_after.as_secs_f64())
    .bind(limit)
    .fetch_all(db)
    .await
}
