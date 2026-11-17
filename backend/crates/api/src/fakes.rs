//! Режим `NIMBUS_FAKE_EXTERNAL=true` (фича `test-fakes`, только для e2e): вместо внешних сервисов
//! поднимается локальный HTTP-сервер с фикстурами MusicBrainz и Torznab-выдачей из одной раздачи,
//! а раздачу отдаёт локальный сидер librqbit. Детерминированно и без сети.
//!
//! Нагрузочный режим (`NIMBUS_FAKE_ARTISTS=N`): вместо фикстур — синтетический каталог из N артистов
//! (`NIMBUS_FAKE_ALBUMS_PER_ARTIST` × `NIMBUS_FAKE_TRACKS_PER_ALBUM`), у первых
//! `NIMBUS_FAKE_SWARM_ALBUMS` альбомов есть раздача из маленьких файлов, остальные «не находятся».
//! `NIMBUS_FAKE_LATENCY_MS` и `NIMBUS_FAKE_FAILURE_RATE` (с `NIMBUS_FAKE_SEED`) действуют на оба режима.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use axum::Router;
use nimbus_torrent::fake_swarm::{self, FakeSwarm, Seeder};
use serde::Deserialize;
use serde_json::{json, Value};

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../musicbrainz/tests/fixtures/",
            $name
        ))
    };
}

/// Треки фикстуры `release.json` (OK Computer).
const TRACKS: [&str; 4] = [
    "Airbag",
    "Paranoid Android",
    "Subterranean Homesick Alien",
    "Lift",
];

pub struct Fakes {
    /// База MusicBrainz API (`…/ws/2/`).
    pub mb_base: String,
    pub torznab_url: String,
    /// Адрес сидера — единственный пир для всех торрентов.
    pub peer: SocketAddr,
    _swarm: Option<FakeSwarm>,
    _seeder: Option<Arc<Seeder>>,
}

/// Параметры генератора нагрузки; `artists == 0` — режим фикстур.
#[derive(Debug, Clone)]
pub struct LoadConfig {
    pub artists: u32,
    pub albums_per_artist: u32,
    pub tracks_per_album: u32,
    /// Для скольких первых альбомов (по порядку артист × альбом) существует раздача.
    pub swarm_albums: u32,
    pub latency: Duration,
    pub failure_rate: f64,
    pub seed: u64,
}

impl LoadConfig {
    /// Читает `NIMBUS_FAKE_*`; пустое/неверное значение — значение по умолчанию.
    pub fn from_env() -> Self {
        fn num<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name)
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(default)
        }
        Self {
            artists: num("NIMBUS_FAKE_ARTISTS", 0),
            albums_per_artist: num("NIMBUS_FAKE_ALBUMS_PER_ARTIST", 15).max(1),
            tracks_per_album: num("NIMBUS_FAKE_TRACKS_PER_ALBUM", 12).clamp(1, 99),
            swarm_albums: num("NIMBUS_FAKE_SWARM_ALBUMS", 40),
            latency: Duration::from_millis(num("NIMBUS_FAKE_LATENCY_MS", 0)),
            failure_rate: num::<f64>("NIMBUS_FAKE_FAILURE_RATE", 0.0).clamp(0.0, 1.0),
            seed: num("NIMBUS_FAKE_SEED", 1),
        }
    }
}

/// splitmix64: детерминированный «случайный» ряд от seed и номера запроса.
fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// Нужно ли отказать на `n`-м запросе: доля `rate` при seed.
fn should_fail(seed: u64, n: u64, rate: f64) -> bool {
    rate > 0.0 && (mix(seed ^ mix(n)) >> 11) as f64 / (1u64 << 53) as f64 <= rate
}

/// Моно 16-bit PCM WAV с синусом 440 Гц.
pub fn sine_wav(seconds: u32) -> Vec<u8> {
    const RATE: u32 = 22_050;
    let samples = RATE * seconds;
    let data_len = samples * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..samples {
        let t = i as f32 / RATE as f32;
        let v = (t * 440.0 * std::f32::consts::TAU).sin() * 0.3;
        out.extend_from_slice(&((v * i16::MAX as f32) as i16).to_le_bytes());
    }
    out
}

pub async fn start(work_dir: &Path) -> anyhow::Result<Fakes> {
    let cfg = LoadConfig::from_env();
    let counter = Arc::new(AtomicU64::new(0));
    let (router, swarm, seeder, peer) = if cfg.artists > 0 {
        let seeder = Arc::new(Seeder::new(&work_dir.join("fake-swarm")).await?);
        let peer = seeder.addr;
        let state = Catalog {
            cfg: cfg.clone(),
            seeder: seeder.clone(),
            made: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        };
        // Одноразовая фоновая задача тестового режима: завершается сама, отслеживать её незачем.
        tokio::spawn(seed_catalog(state.clone()));
        let router = Router::new()
            .route("/ws/2/{*path}", get(mb_catalog))
            .route("/torznab/api", get(torznab_catalog))
            .with_state(state);
        (router, None, Some(seeder), peer)
    } else {
        let files: Vec<(String, Vec<u8>)> = TRACKS
            .iter()
            .enumerate()
            .map(|(i, t)| (format!("{:02} - {t}.wav", i + 1), sine_wav(8)))
            .collect();
        let swarm = fake_swarm::start(&work_dir.join("fake-swarm"), "OK Computer", &files).await?;
        let peer = swarm.addr;
        let router = Router::new()
            .route("/ws/2/{*path}", get(mb))
            .route("/torznab/api", get(torznab))
            .with_state(swarm.magnet.clone());
        (router, Some(swarm), None, peer)
    };
    let chaos = Chaos {
        cfg: cfg.clone(),
        counter,
    };
    let app = router.layer(axum::middleware::from_fn_with_state(chaos, chaos_layer));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tracing::warn!(%addr, %peer, ?cfg, "NIMBUS_FAKE_EXTERNAL: fake MusicBrainz/Torznab and local seeder are running");
    Ok(Fakes {
        mb_base: format!("http://{addr}/ws/2/"),
        torznab_url: format!("http://{addr}/torznab"),
        peer,
        _swarm: swarm,
        _seeder: seeder,
    })
}

#[derive(Clone)]
struct Chaos {
    cfg: LoadConfig,
    counter: Arc<AtomicU64>,
}

/// Задержка и детерминированные отказы (503) перед каждым запросом к фейкам.
async fn chaos_layer(
    State(chaos): State<Chaos>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !chaos.cfg.latency.is_zero() {
        tokio::time::sleep(chaos.cfg.latency).await;
    }
    let n = chaos.counter.fetch_add(1, Ordering::Relaxed);
    if should_fail(chaos.cfg.seed, n, chaos.cfg.failure_rate) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    next.run(req).await
}

// ------------------------------------------------------------------ синтетический каталог

#[derive(Clone)]
struct Catalog {
    cfg: LoadConfig,
    seeder: Arc<Seeder>,
    /// (артист, альбом) → magnet уже созданной раздачи.
    made: Arc<tokio::sync::Mutex<HashMap<(u32, u32), String>>>,
}

fn uuid_for(kind: char, a: u32, b: u64) -> String {
    format!("{kind}0000000-{a:04x}-4000-8000-{b:012x}")
}

/// Разбор `kind0000000-AAAA-4000-8000-BBBBBBBBBBBB` → (a, b).
fn parse_id(id: &str) -> Option<(u32, u64)> {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5 {
        return None;
    }
    Some((
        u32::from_str_radix(parts[1], 16).ok()?,
        u64::from_str_radix(parts[4], 16).ok()?,
    ))
}

fn artist_name(a: u32) -> String {
    format!("Load Artist {a:04}")
}

fn album_title(b: u32) -> String {
    format!("Album {b:02}")
}

fn album_year(b: u32) -> u32 {
    1970 + b
}

fn credit(a: u32) -> Value {
    json!([{ "name": artist_name(a), "joinphrase": "", "artist": {
        "id": uuid_for('a', 0, u64::from(a)), "name": artist_name(a),
        "sort-name": artist_name(a), "disambiguation": "" } }])
}

fn artist_json(a: u32) -> Value {
    json!({ "id": uuid_for('a', 0, u64::from(a)), "name": artist_name(a),
        "sort-name": artist_name(a), "type": "Group", "country": "GB", "disambiguation": "", "score": 100 })
}

fn group_json(a: u32, b: u32) -> Value {
    json!({ "id": uuid_for('d', a, u64::from(b)), "title": album_title(b),
        "primary-type": "Album", "secondary-types": [],
        "first-release-date": format!("{}-01-01", album_year(b)), "artist-credit": credit(a) })
}

fn release_json(cfg: &LoadConfig, a: u32, b: u32) -> Value {
    let tracks: Vec<Value> = (1..=cfg.tracks_per_album)
        .map(|t| {
            let key = u64::from(b) * 100 + u64::from(t);
            json!({ "id": uuid_for('e', a, key), "number": t.to_string(), "position": t,
                "title": format!("Track {t:02}"), "length": 1000,
                "recording": { "id": uuid_for('f', a, key), "title": format!("Track {t:02}"),
                    "length": 1000, "video": false } })
        })
        .collect();
    json!({ "id": uuid_for('c', a, u64::from(b)), "title": album_title(b), "status": "Official",
        "date": format!("{}-01-01", album_year(b)), "country": "XW",
        "release-group": { "id": uuid_for('d', a, u64::from(b)) },
        "media": [{ "position": 1, "format": "Digital Media", "title": "",
            "track-count": cfg.tracks_per_album, "tracks": tracks }] })
}

#[derive(Deserialize)]
struct CatalogQuery {
    query: Option<String>,
    artist: Option<String>,
    #[serde(rename = "release-group")]
    release_group: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

fn page(
    items: Vec<Value>,
    q: &CatalogQuery,
    count_key: &str,
    offset_key: &str,
    list_key: &str,
) -> Response {
    let total = items.len();
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(25).min(100);
    let slice: Vec<Value> = items.into_iter().skip(offset).take(limit).collect();
    Json(json!({ count_key: total, offset_key: offset, list_key: slice })).into_response()
}

async fn mb_catalog(
    State(st): State<Catalog>,
    UrlPath(path): UrlPath<String>,
    Query(q): Query<CatalogQuery>,
) -> Response {
    let cfg = &st.cfg;
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let artist_of = |id: &str| {
        parse_id(id)
            .map(|(_, b)| b as u32)
            .filter(|a| *a < cfg.artists)
    };
    match parts.as_slice() {
        ["artist"] => {
            // Запрос с номером («… 0042») находит этого артиста, иначе — первых пятерых.
            let digits: String = q
                .query
                .as_deref()
                .unwrap_or("")
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            let hits: Vec<Value> = match digits.parse::<u32>() {
                Ok(n) if n < cfg.artists => vec![artist_json(n)],
                _ => (0..cfg.artists.min(5)).map(artist_json).collect(),
            };
            Json(json!({ "count": hits.len(), "offset": 0, "artists": hits })).into_response()
        }
        ["artist", id] => match artist_of(id) {
            Some(a) => Json(artist_json(a)).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        ["release-group"] => match q.artist.as_deref().and_then(artist_of) {
            Some(a) => page(
                (0..cfg.albums_per_artist)
                    .map(|b| group_json(a, b))
                    .collect(),
                &q,
                "release-group-count",
                "release-group-offset",
                "release-groups",
            ),
            None => Json(json!({ "count": 0, "offset": 0, "release-groups": [] })).into_response(),
        },
        ["release-group", id] => match parse_id(id) {
            Some((a, b)) if a < cfg.artists && (b as u32) < cfg.albums_per_artist => {
                Json(group_json(a, b as u32)).into_response()
            }
            _ => StatusCode::NOT_FOUND.into_response(),
        },
        ["release"] => {
            if let Some(a) = q.artist.as_deref().and_then(artist_of) {
                return page(
                    (0..cfg.albums_per_artist)
                        .map(|b| release_json(cfg, a, b))
                        .collect(),
                    &q,
                    "release-count",
                    "release-offset",
                    "releases",
                );
            }
            match q.release_group.as_deref().and_then(parse_id) {
                Some((a, b)) if a < cfg.artists && (b as u32) < cfg.albums_per_artist => {
                    Json(json!({ "release-count": 1, "release-offset": 0,
                        "releases": [release_json(cfg, a, b as u32)] }))
                    .into_response()
                }
                _ => Json(json!({ "release-count": 0, "release-offset": 0, "releases": [] }))
                    .into_response(),
            }
        }
        ["release", id] => match parse_id(id) {
            Some((a, b)) if a < cfg.artists && (b as u32) < cfg.albums_per_artist => {
                Json(release_json(cfg, a, b as u32)).into_response()
            }
            _ => StatusCode::NOT_FOUND.into_response(),
        },
        ["recording"] => {
            Json(json!({ "count": 0, "offset": 0, "release-groups": [], "recordings": [] }))
                .into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Раздача альбома `(a, b)` в локальном сидере (создаётся один раз); возвращает magnet.
async fn seed_album(st: &Catalog, a: u32, b: u32) -> anyhow::Result<String> {
    let mut made = st.made.lock().await;
    if let Some(m) = made.get(&(a, b)) {
        return Ok(m.clone());
    }
    let name = format!(
        "{} - {} ({}) [FLAC]",
        artist_name(a),
        album_title(b),
        album_year(b)
    );
    let files: Vec<(String, Vec<u8>)> = (1..=st.cfg.tracks_per_album)
        .map(|t| (format!("{t:02} - Track {t:02}.wav"), sine_wav(1)))
        .collect();
    let album = st.seeder.add_album(&name, &files).await?;
    made.insert((a, b), album.magnet.clone());
    Ok(album.magnet)
}

/// Раздаёт все альбомы каталога, у которых есть раздача, не дожидаясь поиска. Настоящие раздающие
/// не исчезают от перезапуска Nimbus: без этого после рестарта процесса (сидер живёт в нём же)
/// уже найденные раздачи оставались бы без пиров до следующего поискового запроса.
async fn seed_catalog(st: Catalog) {
    let per_artist = u64::from(st.cfg.albums_per_artist);
    let total = u64::from(st.cfg.swarm_albums).min(u64::from(st.cfg.artists) * per_artist);
    for ordinal in 0..total {
        let (a, b) = ((ordinal / per_artist) as u32, (ordinal % per_artist) as u32);
        if let Err(e) = seed_album(&st, a, b).await {
            tracing::error!(error = %e, a, b, "fake swarm: cannot seed album torrent");
        }
    }
}

#[derive(Deserialize)]
struct TorznabQuery {
    q: Option<String>,
}

/// Ищет в запросе `Load Artist NNNN` и `Album NN` (в любом регистре).
fn parse_wanted(q: &str) -> Option<(u32, u32)> {
    let lower = q.to_lowercase();
    let after = |key: &str| -> Option<u32> {
        let rest = &lower[lower.find(key)? + key.len()..];
        let digits: String = rest
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    };
    Some((after("artist")?, after("album")?))
}

async fn torznab_catalog(State(st): State<Catalog>, Query(q): Query<TorznabQuery>) -> Response {
    let cfg = &st.cfg;
    let empty = || {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fake</title></channel></rss>"#;
        ([(header::CONTENT_TYPE, "application/xml")], xml).into_response()
    };
    let Some((a, b)) = q.q.as_deref().and_then(parse_wanted) else {
        return empty();
    };
    let ordinal = u64::from(a) * u64::from(cfg.albums_per_artist) + u64::from(b);
    if a >= cfg.artists || b >= cfg.albums_per_artist || ordinal >= u64::from(cfg.swarm_albums) {
        return empty();
    }
    let magnet = match seed_album(&st, a, b).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = %e, "fake swarm: cannot create album torrent");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let title = format!(
        "{} - {} ({}) [FLAC]",
        artist_name(a),
        album_title(b),
        album_year(b)
    );
    let size = u64::from(cfg.tracks_per_album) * 44_144;
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Fake</title>
    <item>
      <title>{title}</title>
      <guid>fake-{a}-{b}</guid>
      <link>{}</link>
      <size>{size}</size>
      <torznab:attr name="category" value="3040"/>
      <torznab:attr name="seeders" value="50"/>
      <torznab:attr name="peers" value="55"/>
    </item>
  </channel>
</rss>"#,
        magnet.replace('&', "&amp;")
    );
    ([(header::CONTENT_TYPE, "application/xml")], xml).into_response()
}

fn json(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[derive(Deserialize)]
struct MbQuery {
    #[serde(rename = "release-group")]
    release_group: Option<String>,
    artist: Option<String>,
}

async fn mb(UrlPath(path): UrlPath<String>, Query(q): Query<MbQuery>) -> Response {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match parts.as_slice() {
        ["artist"] => json(fixture!("search_artist.json")),
        ["artist", _] => json(fixture!("artist.json")),
        ["release-group"] if q.artist.is_some() => json(fixture!("artist_release_groups_p1.json")),
        ["release-group"] => json(fixture!("search_release_group.json")),
        ["release-group", _] => json(fixture!("release_group.json")),
        ["recording"] => json(fixture!("search_recording.json")),
        ["recording", _] => json(fixture!("recording_lookup.json")),
        ["release"] if q.release_group.is_some() => json(fixture!("releases_browse.json")),
        ["release", _] => json(fixture!("release.json")),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn torznab(State(magnet): State<String>) -> Response {
    let magnet = magnet.replace('&', "&amp;");
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Fake</title>
    <item>
      <title>Radiohead - OK Computer (1997) [FLAC]</title>
      <guid>fake-ok-computer</guid>
      <link>{magnet}</link>
      <size>2000000</size>
      <torznab:attr name="category" value="3040"/>
      <torznab:attr name="seeders" value="50"/>
      <torznab:attr name="peers" value="55"/>
    </item>
  </channel>
</rss>"#
    );
    ([(header::CONTENT_TYPE, "application/xml")], xml).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_deterministic_and_close_to_rate() {
        let a: Vec<bool> = (0..10_000).map(|n| should_fail(7, n, 0.3)).collect();
        let b: Vec<bool> = (0..10_000).map(|n| should_fail(7, n, 0.3)).collect();
        assert_eq!(a, b);
        let share = a.iter().filter(|f| **f).count() as f64 / a.len() as f64;
        assert!((share - 0.3).abs() < 0.03, "{share}");
        assert!(!(0..1000).any(|n| should_fail(7, n, 0.0)));
        assert_ne!(
            a,
            (0..10_000)
                .map(|n| should_fail(8, n, 0.3))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn ids_roundtrip() {
        assert_eq!(parse_id(&uuid_for('d', 0x12, 77)), Some((0x12, 77)));
        assert_eq!(parse_id("nonsense"), None);
    }

    #[test]
    fn wanted_album_is_parsed_from_query() {
        assert_eq!(parse_wanted("Load Artist 0042 Album 03"), Some((42, 3)));
        assert_eq!(parse_wanted("load artist 7 - album 12 flac"), Some((7, 12)));
        assert_eq!(parse_wanted("Radiohead OK Computer"), None);
    }

    #[test]
    fn release_has_requested_tracks() {
        let cfg = LoadConfig {
            artists: 2,
            albums_per_artist: 3,
            tracks_per_album: 5,
            swarm_albums: 0,
            latency: Duration::ZERO,
            failure_rate: 0.0,
            seed: 1,
        };
        let r = release_json(&cfg, 1, 2);
        assert_eq!(r["media"][0]["tracks"].as_array().map(Vec::len), Some(5));
    }
}
