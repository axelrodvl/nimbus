// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Бенчмарк конвейера «добавили артиста → все треки найдены» (шаг 29). Тяжёлый, поэтому `#[ignore]`:
//! `cargo test -p nimbus-worker --test pipeline_bench -- --ignored --nocapture`.
//!
//! Все внешние системы фейковые и отвечают с задержкой 50 мс: MusicBrainz (wiremock), провайдер
//! торрентов и загрузчик метаданных. Время — реальное.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use nimbus_core::events::EventBus;
use nimbus_core::model::{InfoHash, TorrentSource};
use nimbus_core::settings::PerformanceSettings;
use nimbus_library::LibraryService;
use nimbus_musicbrainz::{MbClient, MbConfig};
use nimbus_torrent::{EngineError, FileEntry, MetadataFetcher, TorrentMeta};
use nimbus_trackers::*;
use nimbus_worker::handlers::handlers;
use nimbus_worker::{JobCtx, WorkerConfig, WorkerPool};
use serde_json::{json, Value};
use sqlx::PgPool;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const ALBUMS: usize = 30;
const TRACKS: usize = 8;
const DELAY: Duration = Duration::from_millis(50);
const ARTIST: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

fn rg_id(k: usize) -> String {
    format!("d0000000-0000-4000-8000-{k:012}")
}
fn release_id(k: usize) -> String {
    format!("c0000000-0000-4000-8000-{k:012}")
}
fn album_title(k: usize) -> String {
    format!("Album {k:02}")
}
fn track_title(k: usize, j: usize) -> String {
    format!("Song {k:02}x{j:02}")
}
fn hash(k: usize) -> InfoHash {
    InfoHash::parse(&format!("{:02x}", k + 1).repeat(20)).unwrap()
}
fn files(k: usize) -> Vec<(String, u64)> {
    (1..=TRACKS)
        .map(|j| {
            (
                format!(
                    "Radiohead - {} (2000) [FLAC]/{j:02} - {}.flac",
                    album_title(k),
                    track_title(k, j)
                ),
                30_000_000,
            )
        })
        .collect()
}

struct Mb;

impl Respond for Mb {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let p = req.url.path().to_string();
        let credit = json!([{"name": "Radiohead", "joinphrase": "", "artist": {
            "id": ARTIST, "name": "Radiohead", "sort-name": "Radiohead", "disambiguation": ""}}]);
        let body: Value = if p.ends_with(&format!("/artist/{ARTIST}")) {
            json!({"id": ARTIST, "name": "Radiohead", "sort-name": "Radiohead", "disambiguation": ""})
        } else if p.ends_with("/release-group") {
            let groups: Vec<Value> = (1..=ALBUMS)
                .map(|k| json!({"id": rg_id(k), "title": album_title(k), "primary-type": "Album",
                    "secondary-types": [], "first-release-date": "2000-01-01", "artist-credit": credit}))
                .collect();
            json!({"release-group-count": ALBUMS, "release-group-offset": 0, "release-groups": groups})
        } else if p.ends_with("/release") {
            let rg = req
                .url
                .query_pairs()
                .find(|(k, _)| k == "release-group")
                .map(|(_, v)| v.to_string())
                .unwrap();
            let k: usize = rg.rsplit('-').next().unwrap().parse().unwrap();
            json!({"release-count": 1, "release-offset": 0, "releases": [{
                "id": release_id(k), "title": album_title(k), "status": "Official", "date": "2000-01-01",
                "country": "XW", "media": [{"position": 1, "format": "Digital Media",
                "track-count": TRACKS, "title": ""}]}]})
        } else {
            let k: usize = p.rsplit('-').next().unwrap().parse().unwrap();
            let tracks: Vec<Value> = (1..=TRACKS)
                .map(|j| json!({"id": format!("e0000000-0000-4000-{k:04}-{j:012}"), "number": j.to_string(),
                    "position": j, "title": track_title(k, j), "length": 180000,
                    "recording": {"id": format!("f0000000-0000-4000-{k:04}-{j:012}"),
                        "title": track_title(k, j), "length": 180000, "video": false}}))
                .collect();
            json!({"id": release_id(k), "title": album_title(k), "status": "Official", "date": "2000-01-01",
                "media": [{"position": 1, "format": "Digital Media", "title": "",
                "track-count": TRACKS, "tracks": tracks}]})
        };
        ResponseTemplate::new(200)
            .set_body_raw(body.to_string(), "application/json")
            .set_delay(DELAY)
    }
}

/// Провайдер: на запрос с «Album NN» отдаёт раздачу этого альбома.
struct FakeProvider;

#[async_trait]
impl TorrentProvider for FakeProvider {
    fn source(&self) -> TorrentSource {
        TorrentSource::Tpb
    }
    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        tokio::time::sleep(DELAY).await;
        let Some(i) = q.text.find("Album ") else {
            return Ok(vec![]);
        };
        let k: usize = q.text[i + 6..i + 8].parse().unwrap();
        Ok(vec![TorrentCandidate {
            source: TorrentSource::Tpb,
            source_topic_id: Some(k.to_string()),
            title: format!("Radiohead - {} (2000) [FLAC]", album_title(k)),
            info_hash: Some(hash(k)),
            magnet: Some(format!("magnet:?xt=urn:btih:{}", hash(k))),
            download_url: None,
            size_bytes: Some(300_000_000),
            seeders: Some(20),
            leechers: Some(1),
            category: None,
            files_count: None,
            torrent_file: None,
        }])
    }
}

struct FakeFetcher;

#[async_trait]
impl MetadataFetcher for FakeFetcher {
    async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError> {
        tokio::time::sleep(DELAY).await;
        let h = InfoHash::from_magnet(magnet).unwrap();
        let k = (0..ALBUMS + 1).find(|k| hash(*k) == h).unwrap();
        Ok(TorrentMeta {
            info_hash: h,
            name: "t".into(),
            piece_length: 16384,
            files: files(k)
                .into_iter()
                .enumerate()
                .map(|(index, (path, size))| FileEntry { index, path, size })
                .collect(),
            torrent_file: None,
        })
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
#[ignore = "бенчмарк: ~минуты реального времени; запускать вручную"]
async fn add_artist_with_30_albums_until_all_tracks_found(test_pool: PgPool) {
    // Свой пул (как в боевом процессе: `10 + воркеры`): пул `sqlx::test` слишком мал для 26 воркеров.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(40)
        .connect_with((*test_pool.connect_options()).clone())
        .await
        .unwrap();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(".*"))
        .respond_with(Mb)
        .mount(&server)
        .await;
    let mut cfg = MbConfig::new("NimbusBench/0.1 ( https://example.org )");
    cfg.base = format!("{}/ws/2/", server.uri()).parse().unwrap();
    cfg.lb_base = None;
    cfg.min_interval = Duration::from_millis(1);
    let mb = MbClient::with_config(cfg, None).unwrap();

    let events = EventBus::new();
    let registry = Arc::new(ProviderRegistry::new(vec![Arc::new(FakeProvider)]));
    let ctx = JobCtx::new(pool.clone(), events.clone(), mb.clone(), registry)
        .with_fetcher(Arc::new(FakeFetcher));
    let workers = WorkerPool::start(
        ctx,
        handlers(&PerformanceSettings::default()),
        WorkerConfig {
            poll_interval: Duration::from_millis(100),
            ..WorkerConfig::default()
        },
    )
    .await
    .unwrap();

    let lib = LibraryService::new(pool.clone(), mb, events);
    let started = Instant::now();
    lib.add_artist(ARTIST.parse().unwrap()).await.unwrap();

    let want = (ALBUMS * TRACKS) as i64;
    let mut first_found = None;
    loop {
        let found: i64 =
            sqlx::query_scalar("SELECT count(*) FROM tracks WHERE in_library AND status = 'found'")
                .fetch_one(&pool)
                .await
                .unwrap();
        if found > 0 && first_found.is_none() {
            first_found = Some(started.elapsed());
        }
        if found == want {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(900),
            "pipeline did not finish: {found}/{want}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!(
        "BENCH add_artist -> first track found: {:.1}s, all {want} tracks found: {:.1}s",
        first_found.unwrap().as_secs_f32(),
        started.elapsed().as_secs_f32()
    );
    workers.shutdown().await;
}
