//! Задача `RetryMissing`: автоматический повтор поиска для альбомов, которые не нашлись.

use async_trait::async_trait;
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_db::repo::{acquisition, jobs};
use nimbus_library::retry::{publish_tracks, retry_album_in, RetryOptions};
use sqlx::Acquire;

use crate::runner::{JobCtx, JobError, JobHandler};

/// Сколько альбомов берёт один запуск (остальные дождутся следующего).
pub const BATCH: i64 = 200;

/// На сколько откладывается альбом, повтор которого не удался (ошибка БД на этом альбоме).
const POSTPONE: std::time::Duration = std::time::Duration::from_secs(3600);

pub struct RetryMissingHandler;

#[async_trait]
impl JobHandler for RetryMissingHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::RETRY_MISSING]
    }

    /// Усыновляет альбомы без расписания, затем берёт до [`BATCH`] альбомов, которым нужен повтор, с наступившим `next_retry_at` и ставит им
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
        let adopted = acquisition::adopt_orphans(&mut tx, BATCH).await?;
        if adopted > 0 {
            tracing::warn!(albums = adopted, "albums without a retry schedule adopted");
        }
        let ids = acquisition::take_due(&mut tx, BATCH).await?;
        let mut changed = Vec::new();
        let mut failed = 0usize;
        for id in &ids {
            // Каждый альбом — в своей точке сохранения: сбой одного не откатывает остальных.
            let mut sp = (&mut *tx).begin().await?;
            match retry_album_in(&mut sp, *id, opts).await {
                Ok((c, _)) => {
                    sp.commit().await?;
                    changed.extend(c);
                }
                Err(e) => {
                    sp.rollback().await?;
                    failed += 1;
                    tracing::warn!(album_id = id, error = %e, "auto-retry of the album failed, postponed");
                    acquisition::postpone(&mut *tx, *id, POSTPONE).await?;
                }
            }
        }
        if failed > 0 && failed == ids.len() {
            // Упали все — вероятно, общая причина: откатываем порцию, пусть сработает backoff задачи.
            return Err(JobError::Unexpected(format!(
                "auto-retry failed for all {failed} albums"
            )));
        }
        if ids.len() as i64 == BATCH {
            // Полная порция: очередь не разобрана, продолжаем сразу (у выполняющейся задачи это `rerun`).
            jobs::enqueue(
                &mut *tx,
                &Job::RetryMissing,
                jobs::EnqueueOpts::priority(PRIORITY_BACKGROUND),
            )
            .await?;
        }
        tx.commit().await?;
        publish_tracks(&ctx.events, &changed);
        if ids.len() > failed {
            tracing::info!(
                albums = ids.len() - failed,
                "auto-retry of missing albums queued"
            );
        }
        Ok(())
    }
}
