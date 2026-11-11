use std::sync::Arc;
use std::time::Duration;

use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_library::LibraryService;
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::TorrentEngine;
use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub events: EventBus,
    pub mb: MbClient,
    pub library: LibraryService,
    /// Торрент-движок (в тестах без торрентов отсутствует).
    pub engine: Option<Arc<TorrentEngine>>,
    /// Общий таймаут эндпоинта поиска.
    pub search_timeout: Duration,
}

impl AppState {
    pub fn new(db: PgPool, config: Arc<Config>, events: EventBus, mb: MbClient) -> Self {
        Self {
            library: LibraryService::new(db.clone(), mb.clone(), events.clone()),
            engine: None,
            db,
            config,
            events,
            mb,
            search_timeout: Duration::from_secs(12),
        }
    }

    pub fn with_engine(mut self, engine: Arc<TorrentEngine>) -> Self {
        self.engine = Some(engine);
        self
    }
}
