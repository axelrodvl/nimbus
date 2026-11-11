//! Обработчики задач. Пока — заглушки (реальная логика: шаги 14 и 17).

use std::sync::Arc;

use async_trait::async_trait;
use nimbus_core::jobs::Job;

use crate::runner::{JobCtx, JobError, JobHandler};

pub struct StubDiscover;
pub struct StubVerify;

#[async_trait]
impl JobHandler for StubDiscover {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::DISCOVER_ALBUM, Job::DISCOVER_ARTIST]
    }
    async fn handle(&self, job: Job, _ctx: &JobCtx) -> Result<(), JobError> {
        tracing::info!(?job, "stub discover handler");
        Ok(())
    }
}

#[async_trait]
impl JobHandler for StubVerify {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::VERIFY_TORRENT]
    }
    async fn handle(&self, job: Job, _ctx: &JobCtx) -> Result<(), JobError> {
        tracing::info!(?job, "stub verify handler");
        Ok(())
    }
}

/// Обработчики по умолчанию с параллелизмом: discover_* — 2, verify_torrent — 4.
pub fn default_handlers() -> Vec<(Arc<dyn JobHandler>, usize)> {
    vec![(Arc::new(StubDiscover), 2), (Arc::new(StubVerify), 4)]
}
