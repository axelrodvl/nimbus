//! Исполнители фоновых задач.

pub mod discover;
pub mod handlers;
pub mod runner;
pub mod verify;

pub use runner::{JobCtx, JobError, JobHandler, WorkerConfig, WorkerPool};
