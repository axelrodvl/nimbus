//! Репозитории: функции принимают `impl PgExecutor` (пул или транзакцию),
//! если нужна атомарность нескольких запросов — `&PgPool`.

pub mod acquisition;
pub mod album_torrents;
pub mod albums;
pub mod artists;
pub mod cue_candidates;
pub mod downloads;
pub mod jobs;
pub mod mb_cache;
pub mod pins;
pub mod playlists;
pub mod torrents;
pub mod track_sources;
pub mod tracks;
pub mod views;
