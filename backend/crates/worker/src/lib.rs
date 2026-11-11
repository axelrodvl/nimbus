//! Исполнители фоновых задач.

pub mod handlers;
pub mod runner;

pub use runner::{JobCtx, JobError, JobHandler, WorkerConfig, WorkerPool};
