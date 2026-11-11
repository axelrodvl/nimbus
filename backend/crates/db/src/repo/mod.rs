//! Репозитории: функции принимают `impl PgExecutor` (пул или транзакцию),
//! если нужна атомарность нескольких запросов — `&PgPool`.

pub mod album_torrents;
pub mod albums;
pub mod artists;
pub mod downloads;
pub mod jobs;
pub mod mb_cache;
pub mod torrents;
pub mod track_sources;
pub mod tracks;
