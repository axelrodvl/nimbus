//! Пул соединений, миграции и (с шага 04) репозитории.

pub mod helpers;
pub mod repo;
pub mod settings;

use sqlx::postgres::PgPoolOptions;
pub use sqlx::PgPool;

/// Минимальный размер пула соединений.
pub const MIN_POOL_CONNECTIONS: u32 = 20;

/// Размер пула: 10 соединений на API и служебные нужды плюс по одному на каждый воркер, не меньше 20.
pub fn pool_size(workers: u32) -> u32 {
    (10 + workers).max(MIN_POOL_CONNECTIONS)
}

/// Пул минимального размера (запуск: миграции и чтение настроек).
pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    connect_sized(url, MIN_POOL_CONNECTIONS).await
}

/// Пул с заданным максимумом соединений; ожидание свободного соединения — не дольше 30 с.
pub async fn connect_sized(url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(url)
        .await
}

/// Миграции лежат в `backend/migrations/`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_size_has_a_floor_and_grows_with_workers() {
        assert_eq!(pool_size(0), 20);
        assert_eq!(pool_size(10), 20);
        assert_eq!(pool_size(26), 36);
        assert_eq!(pool_size(192), 202);
    }
}
