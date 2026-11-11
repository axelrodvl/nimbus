//! Провайдеры торрентов: общий trait, TPB (apibay), Torznab.

mod limiter;
pub mod magnet;
pub mod query;
pub mod rank;
pub mod registry;
pub mod rutracker;
pub mod torrent_file;
pub mod torznab;
pub mod tpb;
pub mod types;

pub use magnet::{build_magnet, PUBLIC_TRACKERS};
pub use query::build_queries;
pub use registry::ProviderRegistry;
pub use rutracker::{RutrackerOptions, RutrackerProvider};
pub use torznab::TorznabProvider;
pub use tpb::TpbProvider;
pub use types::*;
