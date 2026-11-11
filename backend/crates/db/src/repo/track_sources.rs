use nimbus_core::model::{NewTrackSource, TrackSource};
use sqlx::{PgExecutor, PgPool};

pub async fn insert(db: impl PgExecutor<'_>, s: &NewTrackSource) -> sqlx::Result<TrackSource> {
    sqlx::query_as(
        "INSERT INTO track_sources (track_id, torrent_id, file_index, match_score, needs_confirmation,
                                    cue_start_ms, cue_end_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (track_id, torrent_id, file_index) DO UPDATE SET
            match_score = EXCLUDED.match_score,
            needs_confirmation = EXCLUDED.needs_confirmation,
            cue_start_ms = EXCLUDED.cue_start_ms,
            cue_end_ms = EXCLUDED.cue_end_ms
         RETURNING *",
    )
    .bind(s.track_id)
    .bind(s.torrent_id)
    .bind(s.file_index)
    .bind(s.match_score)
    .bind(s.needs_confirmation)
    .bind(s.cue_start_ms)
    .bind(s.cue_end_ms)
    .fetch_one(db)
    .await
}

/// Сначала primary, затем по убыванию `match_score`.
pub async fn list_for_track(
    db: impl PgExecutor<'_>,
    track_id: i64,
) -> sqlx::Result<Vec<TrackSource>> {
    sqlx::query_as("SELECT * FROM track_sources WHERE track_id = $1 ORDER BY is_primary DESC, match_score DESC, id")
        .bind(track_id)
        .fetch_all(db)
        .await
}

pub async fn primary_for_track(
    db: impl PgExecutor<'_>,
    track_id: i64,
) -> sqlx::Result<Option<TrackSource>> {
    sqlx::query_as("SELECT * FROM track_sources WHERE track_id = $1 AND is_primary")
        .bind(track_id)
        .fetch_optional(db)
        .await
}

/// Атомарно делает `source_id` единственным primary для трека.
/// `RowNotFound`, если источник не принадлежит треку (изменения откатываются).
pub async fn set_primary(
    pool: &PgPool,
    track_id: i64,
    source_id: i64,
) -> sqlx::Result<TrackSource> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE track_sources SET is_primary = FALSE WHERE track_id = $1 AND is_primary")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    let src = sqlx::query_as(
        "UPDATE track_sources SET is_primary = TRUE WHERE id = $1 AND track_id = $2 RETURNING *",
    )
    .bind(source_id)
    .bind(track_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(src)
}
