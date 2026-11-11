//! Клиент MusicBrainz Web Service v2: лимиты, кэш, single-flight, доменные модели.

mod canonical;
mod client;
mod error;
mod limiter;
mod lucene;
mod model;

pub use canonical::{pick_canonical, score_release, ReleaseBrief};
pub use client::{MbClient, MbConfig, Priority, LOOKUP_TTL, SEARCH_TTL};
pub use error::{MbError, Result};
pub use lucene::{lucene_escape, search_query};
pub use model::{ArtistHit, RecordingHit, ReleaseGroupHit, ReleaseTracklist, TrackItem};

use uuid::Uuid;

/// Обложка из Cover Art Archive (может отсутствовать — CAA вернёт 404).
pub fn cover_url(release_group: Uuid, size: u16) -> String {
    format!("https://coverartarchive.org/release-group/{release_group}/front-{size}")
}
