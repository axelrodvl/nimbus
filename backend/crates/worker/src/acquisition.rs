//! Задача `RetryMissing`: автоматический повтор поиска для альбомов, которые не нашлись.

use async_trait::async_trait;
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_db::repo::acquisition;
use nimbus_library::retry::{publish_tracks, retry_album_in, RetryOptions};

use crate::runner::{JobCtx, JobError, JobHandler};

/// Сколько альбомов берёт один запуск (остальные дождутся следующего).
pub const BATCH: i64 = 200;

pub struct RetryMissingHandler;

#[async_trait]
impl JobHandler for RetryMissingHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::RETRY_MISSING]
    }

    /// Берёт до [`BATCH`] альбомов `missing`/`partial` с наступившим `next_retry_at` и ставит им
    /// поиск с фоновым приоритетом. Выбор и постановка — одна транзакция: повтор задачи или сбой
    /// посередине не теряют альбомы и не удваивают попытки.
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        if !matches!(job, Job::RetryMissing) {
            return Err(JobError::Fatal("unexpected job kind".into()));
        }
        let opts = RetryOptions {
            priority: PRIORITY_BACKGROUND,
            // Раздача могла быть «мёртвой» лишь потому, что раздающий был офлайн: даём ей новую проверку.
            reset_dead: true,
            manual: false,
        };
        let mut tx = ctx.db.begin().await?;
        let ids = acquisition::take_due(&mut tx, BATCH).await?;
        let mut changed = Vec::new();
        for id in &ids {
            changed.extend(retry_album_in(&mut tx, *id, opts).await?.0);
        }
        tx.commit().await?;
        publish_tracks(&ctx.events, &changed);
        if !ids.is_empty() {
            tracing::info!(albums = ids.len(), "auto-retry of missing albums queued");
        }
        Ok(())
    }
}
