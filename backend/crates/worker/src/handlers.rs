//! Обработчики задач по умолчанию.

use std::sync::Arc;

use async_trait::async_trait;
use nimbus_core::jobs::Job;
use nimbus_library::{LibraryError, LibraryService};

use crate::runner::{JobCtx, JobError, JobHandler};

/// Импорт дискографии артиста, добавленного в библиотеку (шаг 10).
pub struct ImportArtistHandler;

#[async_trait]
impl JobHandler for ImportArtistHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::IMPORT_ARTIST]
    }
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        let Job::ImportArtist { artist_id } = job else {
            return Err(JobError::Fatal("unexpected job kind".into()));
        };
        let service = LibraryService::new(ctx.db.clone(), ctx.mb.background(), ctx.events.clone());
        let skip = ctx.settings.get().search.skip_secondary_types.clone();
        match service.import_artist_skipping(artist_id, &skip).await {
            Ok(summary) => {
                tracing::info!(
                    artist_id,
                    imported = summary.imported,
                    skipped = summary.skipped,
                    "artist imported"
                );
                Ok(())
            }
            Err(LibraryError::MbUnavailable(reason)) => Err(JobError::Retry {
                after: std::time::Duration::from_secs(60),
                reason,
            }),
            Err(e @ (LibraryError::MbNotFound | LibraryError::NotFound(_))) => {
                Err(JobError::Fatal(e.to_string()))
            }
            Err(e) => Err(JobError::Unexpected(e.to_string())),
        }
    }
}

/// Обработчики по умолчанию с параллелизмом: discover_* — 2, verify_torrent — 4, import_artist — 1, process_cue — 2, evict_cache — 1.
pub fn default_handlers() -> Vec<(Arc<dyn JobHandler>, usize)> {
    vec![
        (Arc::new(crate::discover::DiscoverHandler), 2),
        (Arc::new(crate::verify::VerifyHandler), 4),
        (Arc::new(crate::cue::ProcessCueHandler), 2),
        (Arc::new(crate::cache::EvictHandler), 1),
        (Arc::new(ImportArtistHandler), 1),
    ]
}
