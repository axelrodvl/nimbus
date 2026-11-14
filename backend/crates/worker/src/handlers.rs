//! Обработчики задач по умолчанию.

use std::sync::Arc;

use async_trait::async_trait;
use nimbus_core::events::{Entity, Event};
use nimbus_core::jobs::Job;
use nimbus_core::settings::PerformanceSettings;
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
        match ctx
            .run(service.import_artist_skipping(artist_id, &skip))
            .await?
        {
            Ok(summary) => {
                tracing::info!(
                    artist_id,
                    imported = summary.imported,
                    skipped = summary.skipped,
                    "artist imported"
                );
                Ok(())
            }
            // Пауза растёт: 30 с, 1, 2, 4, 8 мин, затем не больше 10 мин.
            Err(LibraryError::MbUnavailable(reason)) => Err(JobError::Retry {
                after: std::time::Duration::from_secs(
                    (30u64 << ctx.attempt.saturating_sub(1).clamp(0, 5)).min(600),
                ),
                reason,
            }),
            Err(e @ (LibraryError::MbNotFound | LibraryError::NotFound(_))) => {
                Err(JobError::Fatal(e.to_string()))
            }
            Err(e) => Err(JobError::Unexpected(e.to_string())),
        }
    }

    /// Идёт повтор импорта: статус артиста в UI изменился.
    async fn on_retry(&self, job: &Job, ctx: &JobCtx, _reason: &str) {
        if let Job::ImportArtist { artist_id } = job {
            publish_artist_changed(ctx, *artist_id);
        }
    }

    /// Импорт окончательно провален: UI должен увидеть новый статус артиста.
    async fn on_exhausted(&self, job: &Job, ctx: &JobCtx, _reason: &str) -> Result<(), JobError> {
        if let Job::ImportArtist { artist_id } = job {
            publish_artist_changed(ctx, *artist_id);
        }
        Ok(())
    }
}

fn publish_artist_changed(ctx: &JobCtx, artist_id: i64) {
    ctx.events.publish(Event::LibraryChanged {
        entity: Entity::Artist,
        id: artist_id,
    });
}

/// Обработчики с параллелизмом из настроек (`performance`): discover_* — `discover_workers`,
/// verify_torrent — `verify_workers`, import_artist — `import_workers`; process_cue — 2, evict_cache и retry_missing — 1.
pub fn handlers(perf: &PerformanceSettings) -> Vec<(Arc<dyn JobHandler>, usize)> {
    vec![
        (
            Arc::new(crate::discover::DiscoverHandler),
            usize::from(perf.discover_workers),
        ),
        (
            Arc::new(crate::verify::VerifyHandler),
            usize::from(perf.verify_workers),
        ),
        (Arc::new(crate::cue::ProcessCueHandler), 2),
        (Arc::new(crate::cache::EvictHandler), 1),
        (Arc::new(crate::acquisition::RetryMissingHandler), 1),
        (
            Arc::new(ImportArtistHandler),
            usize::from(perf.import_workers),
        ),
    ]
}
