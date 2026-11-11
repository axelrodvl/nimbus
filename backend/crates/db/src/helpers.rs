//! Операции, объединяющие запись в БД и публикацию события.

use nimbus_core::events::{Event, EventBus};
use nimbus_core::model::{NotFoundReason, Track, TrackStatus};
use sqlx::PgExecutor;

use crate::repo::tracks;

/// Меняет статус трека и публикует `track.status`.
pub async fn set_track_status_and_publish(
    db: impl PgExecutor<'_>,
    events: &EventBus,
    track_id: i64,
    status: TrackStatus,
    reason: Option<NotFoundReason>,
) -> sqlx::Result<Track> {
    let t = tracks::set_status(db, track_id, status, reason).await?;
    events.publish(Event::TrackStatus {
        track_id: t.id,
        album_id: t.album_id,
        status: t.status,
        reason: t.status_reason.clone(),
    });
    Ok(t)
}
