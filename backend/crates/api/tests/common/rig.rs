//! Стенд сквозных тестов (шаг 35): MusicBrainz (wiremock), фейковые провайдеры, локальный рой,
//! настоящий движок, пул воркеров и API на одной БД.
#![allow(dead_code, clippy::unwrap_used)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nimbus_api::AppState;
use nimbus_core::events::EventBus;
use nimbus_core::model::{InfoHash, TorrentSource};
use nimbus_core::settings::PerformanceSettings;
use nimbus_musicbrainz::{MbClient, MbConfig};
use nimbus_torrent::{fake_swarm, EngineConfig, TorrentEngine};
use nimbus_trackers::*;
use nimbus_worker::handlers::handlers;
use nimbus_worker::{JobCtx, WorkerConfig, WorkerPool};
use rand::RngCore;
use serde_json::{json, Value};
use sqlx::PgPool;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

pub const ARTIST: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
pub const RG: &str = "d0000000-0000-4000-8000-000000000001";
pub const RELEASE: &str = "c0000000-0000-4000-8000-000000000001";
pub const TRACKS: usize = 3;
pub const ALBUM: &str = "Album 01";

pub fn track_title(j: usize) -> String {
    format!("Song 01x{j:02}")
}

/// MusicBrainz с одним артистом, одним альбомом и тремя треками. `flaky` — каждый второй запрос 503.
struct Mb {
    flaky: Arc<AtomicBool>,
    /// Ответы приходят через 30 с (запрос «висит»): имитация зависшего MusicBrainz.
    slow: Arc<AtomicBool>,
    n: AtomicUsize,
}

impl Respond for Mb {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        if self.flaky.load(Ordering::SeqCst)
            && self.n.fetch_add(1, Ordering::SeqCst).is_multiple_of(2)
        {
            return ResponseTemplate::new(503);
        }
        let p = req.url.path().to_string();
        let credit = json!([{"name": "Radiohead", "joinphrase": "", "artist": {
            "id": ARTIST, "name": "Radiohead", "sort-name": "Radiohead", "disambiguation": ""}}]);
        let body: Value = if p.ends_with(&format!("/artist/{ARTIST}")) {
            json!({"id": ARTIST, "name": "Radiohead", "sort-name": "Radiohead", "disambiguation": ""})
        } else if p.ends_with("/release-group") {
            json!({"release-group-count": 1, "release-group-offset": 0, "release-groups": [
                {"id": RG, "title": ALBUM, "primary-type": "Album", "secondary-types": [],
                 "first-release-date": "2000-01-01", "artist-credit": credit}]})
        } else if p.ends_with("/release") {
            json!({"release-count": 1, "release-offset": 0, "releases": [{
                "id": RELEASE, "title": ALBUM, "status": "Official", "date": "2000-01-01",
                "country": "XW", "media": [{"position": 1, "format": "Digital Media",
                "track-count": TRACKS, "title": ""}]}]})
        } else {
            let tracks: Vec<Value> = (1..=TRACKS)
                .map(|j| json!({"id": format!("e0000000-0000-4000-0001-{j:012}"), "number": j.to_string(),
                    "position": j, "title": track_title(j), "length": 180000,
                    "recording": {"id": format!("f0000000-0000-4000-0001-{j:012}"),
                        "title": track_title(j), "length": 180000, "video": false}}))
                .collect();
            json!({"id": RELEASE, "title": ALBUM, "status": "Official", "date": "2000-01-01",
                "media": [{"position": 1, "format": "Digital Media", "title": "",
                "track-count": TRACKS, "tracks": tracks}]})
        };
        let resp = ResponseTemplate::new(200).set_body_raw(body.to_string(), "application/json");
        if self.slow.load(Ordering::SeqCst) {
            resp.set_delay(Duration::from_secs(30))
        } else {
            resp
        }
    }
}

/// Поведение фейкового провайдера.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Behavior {
    /// Отдаёт раздачу альбома.
    Works,
    /// Всегда ошибка сети.
    Down,
    /// Ответ не приходит (висит): режется таймаутом провайдера в реестре.
    Hangs,
}

pub struct RigProvider {
    pub source: TorrentSource,
    pub behavior: std::sync::Mutex<Behavior>,
    pub calls: AtomicUsize,
    pub magnet: String,
    pub hash: InfoHash,
}

impl RigProvider {
    pub fn set(&self, b: Behavior) {
        *self.behavior.lock().unwrap() = b;
    }
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl TorrentProvider for RigProvider {
    fn source(&self) -> TorrentSource {
        self.source
    }
    async fn search(&self, _q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let b = *self.behavior.lock().unwrap();
        match b {
            Behavior::Down => Err(ProviderError::Network("connection refused".into())),
            Behavior::Hangs => {
                std::future::pending::<()>().await;
                unreachable!("pending never resolves")
            }
            Behavior::Works => Ok(vec![TorrentCandidate {
                source: self.source,
                source_topic_id: Some("1".into()),
                title: format!("Radiohead - {ALBUM} (2000) [FLAC]"),
                info_hash: Some(self.hash.clone()),
                magnet: Some(self.magnet.clone()),
                download_url: None,
                size_bytes: Some(300_000_000),
                seeders: Some(20),
                leechers: Some(1),
                category: None,
                files_count: None,
                torrent_file: None,
            }]),
        }
    }
}

pub struct Rig {
    pub pool: PgPool,
    pub root: std::path::PathBuf,
    pub server: MockServer,
    pub mb: MbClient,
    pub flaky_mb: Arc<AtomicBool>,
    pub slow_mb: Arc<AtomicBool>,
    pub swarm: fake_swarm::FakeSwarm,
    /// Содержимое файлов раздачи по именам (`NN - Song 01xNN.flac`).
    pub contents: Vec<(String, Vec<u8>)>,
    pub engine: Arc<TorrentEngine>,
    pub providers: Vec<Arc<RigProvider>>,
    pub registry: Arc<ProviderRegistry>,
    pub events: EventBus,
    pub state: AppState,
}

impl Rig {
    /// `provider_count` фейковых провайдеров (все изначально `Works`).
    pub async fn start(
        pool: PgPool,
        provider_count: usize,
        metadata_timeout: Duration,
        provider_timeout: Duration,
    ) -> Rig {
        let root = std::env::temp_dir().join(format!("nimbus-rig-{}", uuid::Uuid::new_v4()));
        let contents: Vec<(String, Vec<u8>)> = (1..=TRACKS)
            .map(|j| {
                let mut v = vec![0u8; 120_000 + j * 7_000];
                rand::rng().fill_bytes(&mut v);
                (format!("{j:02} - {}.flac", track_title(j)), v)
            })
            .collect();
        let swarm = fake_swarm::start(&root.join("swarm"), "Album", &contents)
            .await
            .unwrap();
        let mut cfg = EngineConfig::new(root.join("engine"), true);
        cfg.dht = false;
        cfg.persistence = false;
        cfg.localhost_only = true;
        cfg.metadata_timeout = metadata_timeout;
        cfg.initial_peers = vec![swarm.addr];
        let engine = Arc::new(TorrentEngine::new(cfg).await.unwrap());

        let server = MockServer::start().await;
        let flaky_mb = Arc::new(AtomicBool::new(false));
        let slow_mb = Arc::new(AtomicBool::new(false));
        Mock::given(method("GET"))
            .and(path_regex(".*"))
            .respond_with(Mb {
                flaky: flaky_mb.clone(),
                slow: slow_mb.clone(),
                n: AtomicUsize::new(0),
            })
            .mount(&server)
            .await;
        let mut mcfg = MbConfig::new("NimbusTest/0.1 ( https://example.org/test )");
        mcfg.base = format!("{}/ws/2/", server.uri()).parse().unwrap();
        mcfg.lb_base = None;
        mcfg.limits = nimbus_musicbrainz::MbLimits::unlimited(8);
        mcfg.retry_delay = Duration::from_millis(5);
        let mb = MbClient::with_config(mcfg, None).unwrap();

        let hash = InfoHash::parse(&swarm.info_hash).unwrap();
        let sources = [TorrentSource::Tpb, TorrentSource::Torznab];
        let providers: Vec<Arc<RigProvider>> = (0..provider_count)
            .map(|i| {
                Arc::new(RigProvider {
                    source: sources[i % sources.len()],
                    behavior: std::sync::Mutex::new(Behavior::Works),
                    calls: AtomicUsize::new(0),
                    magnet: swarm.magnet.clone(),
                    hash: hash.clone(),
                })
            })
            .collect();
        let registry = Arc::new(
            ProviderRegistry::new(
                providers
                    .iter()
                    .map(|p| p.clone() as Arc<dyn TorrentProvider>)
                    .collect(),
            )
            .with_timeout(provider_timeout),
        );
        let events = EventBus::new();
        let state = super::state_with_mb(pool.clone(), mb.clone())
            .with_engine(engine.clone())
            .with_providers(registry.clone());
        Rig {
            pool,
            root,
            server,
            mb,
            flaky_mb,
            slow_mb,
            swarm,
            contents,
            engine,
            providers,
            registry,
            events,
            state,
        }
    }

    pub fn job_ctx(&self) -> JobCtx {
        JobCtx::new(
            self.pool.clone(),
            self.events.clone(),
            self.mb.clone(),
            self.registry.clone(),
        )
        .with_engine(self.engine.clone())
    }

    /// Новый пул воркеров на той же БД (быстрый опрос и короткий heartbeat).
    pub async fn workers(&self) -> WorkerPool {
        WorkerPool::start(
            self.job_ctx(),
            handlers(&PerformanceSettings::default()),
            WorkerConfig {
                poll_interval: Duration::from_millis(50),
                backoff_base: Duration::from_millis(50),
                backoff_max: Duration::from_millis(500),
                maintenance_interval: Duration::from_millis(200),
                stuck_grace: Duration::from_secs(1),
                shutdown_timeout: Duration::from_secs(2),
                ..WorkerConfig::default()
            },
        )
        .await
        .unwrap()
    }

    /// Пул воркеров только с обработчиками указанных видов задач (остальные остаются в очереди).
    pub async fn workers_only(&self, kinds: &[&str]) -> WorkerPool {
        let hs = handlers(&PerformanceSettings::default())
            .into_iter()
            .filter(|(h, _)| h.kinds().iter().any(|k| kinds.contains(k)))
            .collect();
        WorkerPool::start(
            self.job_ctx(),
            hs,
            WorkerConfig {
                poll_interval: Duration::from_millis(50),
                maintenance_interval: Duration::from_millis(200),
                stuck_grace: Duration::from_secs(1),
                shutdown_timeout: Duration::from_secs(2),
                ..WorkerConfig::default()
            },
        )
        .await
        .unwrap()
    }

    pub async fn finish(self) {
        self.engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
