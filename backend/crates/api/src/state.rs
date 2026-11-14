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
    /// Настройки приложения (редактируются из UI).
    pub settings: nimbus_db::settings::SettingsStore,
    /// Параллелизм воркеров, с которым запущен процесс (меняется только перезапуском).
    pub boot_performance: nimbus_core::settings::PerformanceSettings,
    /// Реестр провайдеров торрентов (пересобирается при изменении настроек).
    pub providers: Arc<nimbus_trackers::ProviderRegistry>,
    /// Активные стримы и недавний prefetch (вытеснение кэша их не трогает).
    pub activity: nimbus_core::activity::Activity,
    /// Перекодирование через ffmpeg (CUE-образы, APE/WV/DSD/AIFF).
    pub transcoder: crate::transcode::Transcoder,
    /// Сколько ждать первых байт стрима, прежде чем ответить `504 no_peers`.
    pub first_byte_timeout: Duration,
    /// Сколько стрим может молчать посреди ответа, прежде чем соединение будет разорвано.
    pub stream_idle_timeout: Duration,
    /// Секрет процесса для внутреннего эндпоинта `/api/internal/raw/…` (заголовок `X-Nimbus-Internal`).
    /// Генерируется при старте, никуда не пишется и не логируется.
    pub internal_token: Arc<str>,
    /// Общий таймаут эндпоинта поиска.
    pub search_timeout: Duration,
    /// Связь менеджера загрузок с API: будильник и живая статистика (скорость, пиры) по альбомам.
    pub downloads: crate::download_manager::DownloadHub,
}

/// Включена ли автозагрузка в текущих настройках.
fn auto_download_flag(
    settings: &nimbus_db::settings::SettingsStore,
) -> impl Fn() -> bool + Send + Sync + 'static {
    let settings = settings.clone();
    move || settings.get().storage.auto_download == "added"
}

/// 32 случайных байта в hex.
fn new_internal_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl AppState {
    pub fn new(db: PgPool, config: Arc<Config>, events: EventBus, mb: MbClient) -> Self {
        let settings = nimbus_db::settings::SettingsStore::new(
            db.clone(),
            nimbus_core::Settings::from_config(&config),
        );
        let library = LibraryService::new(db.clone(), mb.clone(), events.clone())
            .with_auto_download(auto_download_flag(&settings));
        Self {
            boot_performance: settings.get().performance.clone(),
            downloads: crate::download_manager::DownloadHub::default(),
            settings,
            providers: Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
            activity: nimbus_core::activity::Activity::default(),
            library,
            engine: None,
            files: None,
            transcoder: crate::transcode::Transcoder::new("ffmpeg"),
            first_byte_timeout: Duration::from_secs(60),
            stream_idle_timeout: Duration::from_secs(45),
            internal_token: new_internal_token().into(),
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

impl AppState {
    pub fn with_settings(mut self, settings: nimbus_db::settings::SettingsStore) -> Self {
        self.boot_performance = settings.get().performance.clone();
        self.library = self
            .library
            .with_auto_download(auto_download_flag(&settings));
        self.settings = settings;
        self
    }

    pub fn with_providers(mut self, providers: Arc<nimbus_trackers::ProviderRegistry>) -> Self {
        self.providers = providers;
        self
    }

    pub fn with_activity(mut self, activity: nimbus_core::activity::Activity) -> Self {
        self.activity = activity;
        self
    }
}
