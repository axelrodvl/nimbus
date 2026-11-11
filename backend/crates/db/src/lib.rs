//! Пул соединений, миграции и (с шага 04) репозитории.

pub mod helpers;
pub mod repo;

use sqlx::postgres::PgPoolOptions;
pub use sqlx::PgPool;

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new().max_connections(10).connect(url).await
}

/// Миграции лежат в `backend/migrations/`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}
