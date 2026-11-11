use std::sync::Arc;
use std::time::Duration;

use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_library::LibraryService;
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::{FileProvider, TorrentEngine};
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
    /// Источник файлов для стриминга (по умолчанию — движок; в тестах — фейк).
    pub files: Option<Arc<dyn FileProvider>>,
    /// Перекодирование через ffmpeg (CUE-образы, APE/WV/DSD/AIFF).
    pub transcoder: crate::transcode::Transcoder,
    /// Сколько ждать первых байт стрима, прежде чем ответить `504 no_peers`.
    pub first_byte_timeout: Duration,
    /// Общий таймаут эндпоинта поиска.
    pub search_timeout: Duration,
}

impl AppState {
    pub fn new(db: PgPool, config: Arc<Config>, events: EventBus, mb: MbClient) -> Self {
        Self {
            library: LibraryService::new(db.clone(), mb.clone(), events.clone()),
            engine: None,
            files: None,
            transcoder: crate::transcode::Transcoder::new("ffmpeg"),
            first_byte_timeout: Duration::from_secs(60),
            db,
            config,
            events,
            mb,
            search_timeout: Duration::from_secs(12),
        }
    }

    pub fn with_engine(mut self, engine: Arc<TorrentEngine>) -> Self {
        self.files = Some(engine.clone());
        self.engine = Some(engine);
        self
    }

    pub fn with_files(mut self, files: Arc<dyn FileProvider>) -> Self {
        self.files = Some(files);
        self
    }
}

impl AppState {
    pub fn with_transcoder(mut self, transcoder: crate::transcode::Transcoder) -> Self {
        self.transcoder = transcoder;
        self
    }
}
