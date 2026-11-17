// Приёмочный сценарий ревью B14: конвейер под отказами сходится к состоянию, в котором выполнены
// все инварианты `repo::invariants`. Внешний мир — фейки (MusicBrainz на wiremock, провайдер,
// метаданные и файлы раздач), остальное настоящее: очередь, обработчики, менеджер загрузок,
// наблюдатель. unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nimbus_api::download_manager::{spawn_download_manager_with, ManagerConfig};
use nimbus_api::stream::spawn_watcher_with;
use nimbus_api::AppState;
use nimbus_core::jobs::Job;
use nimbus_core::model::{InfoHash, TorrentSource};
use nimbus_core::settings::PerformanceSettings;
use nimbus_db::repo::invariants::{self, Params};
use nimbus_db::settings::SettingsStore;
use nimbus_musicbrainz::{MbClient, MbConfig};
use nimbus_torrent::{
    AsyncReadSeek, EngineError, FileEntry, FileProgress, FileProvider, MetadataFetcher,
    TorrentHandleId, TorrentMeta, TorrentRef,
};
use nimbus_trackers::{
    build_magnet, ProviderError, ProviderRegistry, SearchQuery, TorrentCandidate, TorrentProvider,
};
use nimbus_worker::handlers::handlers;
use nimbus_worker::{JobCtx, JobError, JobHandler, WorkerConfig, WorkerPool};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const LONG: Duration = Duration::from_secs(90);

// ------------------------------------------------------------------ каталог

/// Артист с четырьмя альбомами: у двух — своя раздача, третий есть только в дискографии,
/// четвёртый — образ с CUE. Дискография содержит первые три альбома.
const BAND: &str = "Chaos Band";
/// Артист с одним альбомом, которого нет ни в одной раздаче.
const SOLO: &str = "Quiet Solo";
const PARTS: [&str; 3] = ["Morning", "Noon", "Night"];

struct AlbumSpec {
    artist: u32,
    index: u32,
    title: &'static str,
    word: &'static str,
    year: u32,
}

const ALBUMS: [AlbumSpec; 5] = [
    AlbumSpec {
        artist: 0,
        index: 0,
        title: "Alpha Road",
        word: "Alpha",
        year: 1991,
    },
    AlbumSpec {
        artist: 0,
        index: 1,
        title: "Bravo Sky",
        word: "Bravo",
        year: 1992,
    },
    AlbumSpec {
        artist: 0,
        index: 2,
        title: "Cinder Lake",
        word: "Cinder",
        year: 1993,
    },
    AlbumSpec {
        artist: 0,
        index: 3,
        title: "Delta Tide",
        word: "Delta",
        year: 1994,
    },
    AlbumSpec {
        artist: 1,
        index: 0,
        title: "Hollow Ground",
        word: "Hollow",
        year: 1996,
    },
];

fn uuid_for(kind: char, a: u32, b: u32) -> String {
    format!("{kind}0000000-{a:04x}-4000-8000-{b:012x}")
}

fn artist_name(a: u32) -> &'static str {
    if a == 0 {
        BAND
    } else {
        SOLO
    }
}

fn track_title(al: &AlbumSpec, t: usize) -> String {
    format!("{} {}", al.word, PARTS[t])
}

fn track_file(al: &AlbumSpec, t: usize) -> String {
    format!("{:02} - {}.flac", t + 1, track_title(al, t))
}

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{n:040x}")).unwrap()
}

/// Раздачи: 0 и 1 — альбомы «Alpha Road» и «Bravo Sky», 2 — дискография, 3 — образ с CUE.
const T_ALPHA: u8 = 1;
const T_BRAVO: u8 = 2;
const T_DISCOGRAPHY: u8 = 3;
const T_CUE: u8 = 4;

fn torrent_title(n: u8) -> String {
    match n {
        T_ALPHA => format!("{BAND} - Alpha Road (1991) [FLAC]"),
        T_BRAVO => format!("{BAND} - Bravo Sky (1992) [FLAC]"),
        T_DISCOGRAPHY => format!("{BAND} - Discography 1991-1994 [FLAC]"),
        _ => format!("{BAND} - Delta Tide (1994) [FLAC image+cue]"),
    }
}

const CUE_SHEET: &str = "PERFORMER \"Chaos Band\"\r\nTITLE \"Delta Tide\"\r\nFILE \"Delta Tide.flac\" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE \"Delta Morning\"\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    TITLE \"Delta Noon\"\r\n    INDEX 01 03:00:00\r\n  TRACK 03 AUDIO\r\n    TITLE \"Delta Night\"\r\n    INDEX 01 06:00:00\r\n";

/// Файлы раздачи `(путь, содержимое)`.
fn torrent_files(n: u8) -> Vec<(String, Vec<u8>)> {
    let audio = |name: String| (name, vec![7u8; 4096]);
    match n {
        T_ALPHA => (0..3).map(|t| audio(track_file(&ALBUMS[0], t))).collect(),
        T_BRAVO => (0..3).map(|t| audio(track_file(&ALBUMS[1], t))).collect(),
        T_DISCOGRAPHY => ALBUMS[..3]
            .iter()
            .flat_map(|al| {
                (0..3).map(move |t| {
                    audio(format!("{} - {}/{}", al.year, al.title, track_file(al, t)))
                })
            })
            .collect(),
        _ => vec![
            ("Delta Tide.flac".to_string(), vec![7u8; 8192]),
            ("Delta Tide.cue".to_string(), CUE_SHEET.as_bytes().to_vec()),
        ],
    }
}

fn torrent_of(h: &InfoHash) -> u8 {
    (T_ALPHA..=T_CUE).find(|n| hash(*n) == *h).unwrap()
}

// ------------------------------------------------------------------ MusicBrainz

struct Mb {
    /// Сервис недоступен: первый запрос получает 503, остальные — 500. Долгая серия 503 снизила бы
    /// адаптивный темп клиента до запроса в пять секунд — тест проверяет очередь, а не лимитер.
    down: Arc<AtomicBool>,
    refused: AtomicUsize,
}

fn group_json(al: &AlbumSpec) -> Value {
    let name = artist_name(al.artist);
    json!({"id": uuid_for('d', al.artist, al.index), "title": al.title,
        "primary-type": "Album", "secondary-types": [],
        "first-release-date": format!("{}-01-01", al.year),
        "artist-credit": [{"name": name, "joinphrase": "", "artist": {
            "id": uuid_for('a', 0, al.artist), "name": name, "sort-name": name, "disambiguation": ""}}]})
}

fn release_json(al: &AlbumSpec) -> Value {
    let tracks: Vec<Value> = (0..3)
        .map(|t| {
            let key = al.index * 100 + t as u32 + 1;
            json!({"id": uuid_for('e', al.artist, key), "number": (t + 1).to_string(),
                "position": t + 1, "title": track_title(al, t), "length": 180_000,
                "recording": {"id": uuid_for('f', al.artist, key), "title": track_title(al, t),
                    "length": 180_000, "video": false}})
        })
        .collect();
    json!({"id": uuid_for('c', al.artist, al.index), "title": al.title, "status": "Official",
        "date": format!("{}-01-01", al.year), "country": "XW",
        "release-group": {"id": uuid_for('d', al.artist, al.index)},
        "media": [{"position": 1, "format": "Digital Media", "title": "", "track-count": 3,
            "tracks": tracks}]})
}

impl Respond for Mb {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        if self.down.load(Ordering::SeqCst) {
            let first = self.refused.fetch_add(1, Ordering::SeqCst) == 0;
            return ResponseTemplate::new(if first { 503 } else { 500 });
        }
        let query: HashMap<String, String> = req.url.query_pairs().into_owned().collect();
        let of_artist = |key: &str| -> Vec<&AlbumSpec> {
            let id = query.get(key).cloned().unwrap_or_default();
            ALBUMS
                .iter()
                .filter(|al| uuid_for('a', 0, al.artist) == id)
                .collect()
        };
        let path = req.url.path().trim_end_matches('/').to_string();
        let last = path.rsplit('/').next().unwrap_or_default().to_string();
        let offset: usize = query
            .get("offset")
            .and_then(|o| o.parse().ok())
            .unwrap_or(0);
        let body = if path.ends_with("/release-group") {
            let all: Vec<Value> = of_artist("artist").into_iter().map(group_json).collect();
            json!({"release-group-count": all.len(), "release-group-offset": offset,
                "release-groups": all.into_iter().skip(offset).collect::<Vec<_>>()})
        } else if path.ends_with("/release") {
            let all: Vec<Value> = if query.contains_key("artist") {
                of_artist("artist").into_iter().map(release_json).collect()
            } else {
                let rg = query.get("release-group").cloned().unwrap_or_default();
                ALBUMS
                    .iter()
                    .filter(|al| uuid_for('d', al.artist, al.index) == rg)
                    .map(release_json)
                    .collect()
            };
            json!({"release-count": all.len(), "release-offset": offset,
                "releases": all.into_iter().skip(offset).collect::<Vec<_>>()})
        } else if let Some(al) = ALBUMS
            .iter()
            .find(|al| uuid_for('c', al.artist, al.index) == last)
        {
            release_json(al)
        } else if let Some(al) = ALBUMS
            .iter()
            .find(|al| uuid_for('d', al.artist, al.index) == last)
        {
            group_json(al)
        } else if let Some(a) = (0..2).find(|a| uuid_for('a', 0, *a) == last) {
            json!({"id": last, "name": artist_name(a), "sort-name": artist_name(a), "disambiguation": ""})
        } else {
            return ResponseTemplate::new(404);
        };
        ResponseTemplate::new(200).set_body_raw(body.to_string(), "application/json")
    }
}

// ------------------------------------------------------------------ провайдер

#[derive(Default)]
struct Provider {
    /// Сколько ближайших запросов ответят ошибкой сети.
    fail_left: AtomicUsize,
    /// Сколько ближайших запросов зависнут (их оборвёт таймаут реестра).
    hang_left: AtomicUsize,
    calls: AtomicUsize,
}

/// Уменьшает счётчик, если он не ноль; `true` — уменьшил.
fn take(counter: &AtomicUsize) -> bool {
    let mut current = counter.load(Ordering::SeqCst);
    while current > 0 {
        match counter.compare_exchange(current, current - 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(seen) => current = seen,
        }
    }
    false
}

fn candidate(n: u8) -> TorrentCandidate {
    let title = torrent_title(n);
    TorrentCandidate {
        source: TorrentSource::Tpb,
        source_topic_id: Some(n.to_string()),
        magnet: Some(build_magnet(&hash(n), &title, &[])),
        title,
        info_hash: Some(hash(n)),
        download_url: None,
        size_bytes: Some(300_000_000),
        seeders: Some(20),
        leechers: Some(1),
        category: None,
        files_count: None,
        torrent_file: None,
    }
}

#[async_trait]
impl TorrentProvider for Provider {
    fn source(&self) -> TorrentSource {
        TorrentSource::Tpb
    }

    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if take(&self.fail_left) {
            return Err(ProviderError::Network("connection refused".into()));
        }
        if take(&self.hang_left) {
            std::future::pending::<()>().await;
        }
        let text = q.text.to_lowercase();
        if !text.contains("chaos band") {
            return Ok(vec![]);
        }
        let found = if text.contains("alpha road") {
            vec![T_ALPHA]
        } else if text.contains("bravo sky") {
            vec![T_BRAVO]
        } else if text.contains("delta tide") {
            vec![T_CUE]
        } else if text.contains("cinder lake") {
            vec![]
        } else {
            vec![T_DISCOGRAPHY]
        };
        Ok(found.into_iter().map(candidate).collect())
    }
}

// ------------------------------------------------------------------ раздачи

/// Метаданные и файлы раздач с управляемыми отказами.
struct Swarm {
    root: PathBuf,
    /// Сколько ближайших запросов метаданных раздачи закончатся таймаутом.
    meta_timeouts: Mutex<HashMap<u8, usize>>,
    meta_calls: Mutex<HashMap<u8, usize>>,
    /// Раздачи без пиров: движок не может их даже запустить.
    offline: Mutex<HashSet<u8>>,
    /// Раздачи, которые запускаются, но не отдают ни байта.
    stalled: Mutex<HashSet<u8>>,
    requested: Mutex<HashSet<(u8, usize)>>,
}

impl Swarm {
    fn path(&self, n: u8, index: usize) -> PathBuf {
        let name = torrent_files(n)[index].0.replace('/', "_");
        self.root.join(format!("{n}")).join(name)
    }
}

#[async_trait]
impl MetadataFetcher for Swarm {
    async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError> {
        let info_hash = InfoHash::from_magnet(magnet).ok_or(EngineError::NotFound)?;
        let n = torrent_of(&info_hash);
        *self.meta_calls.lock().unwrap().entry(n).or_default() += 1;
        if let Some(left) = self.meta_timeouts.lock().unwrap().get_mut(&n) {
            if *left > 0 {
                *left -= 1;
                return Err(EngineError::MetadataTimeout);
            }
        }
        Ok(TorrentMeta {
            info_hash,
            name: torrent_title(n),
            files: torrent_files(n)
                .into_iter()
                .enumerate()
                .map(|(index, (path, bytes))| FileEntry {
                    index,
                    path,
                    size: bytes.len() as u64,
                })
                .collect(),
            piece_length: 16384,
            torrent_file: None,
        })
    }
}

#[async_trait]
impl FileProvider for Swarm {
    async fn ensure_file(
        &self,
        torrent: &TorrentRef,
        file_index: usize,
    ) -> Result<TorrentHandleId, EngineError> {
        let info_hash = InfoHash::from_magnet(&torrent.magnet).ok_or(EngineError::NotFound)?;
        let n = torrent_of(&info_hash);
        if self.offline.lock().unwrap().contains(&n) {
            return Err(EngineError::MetadataTimeout);
        }
        self.requested.lock().unwrap().insert((n, file_index));
        Ok(TorrentHandleId(info_hash))
    }

    async fn open_stream(
        &self,
        _: &TorrentHandleId,
        _: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        Err(EngineError::NotFound)
    }

    fn file_progress(&self, id: &TorrentHandleId, file_index: usize) -> Option<FileProgress> {
        let n = torrent_of(&id.0);
        if !self.requested.lock().unwrap().contains(&(n, file_index)) {
            return None;
        }
        let bytes = &torrent_files(n)[file_index].1;
        let total = bytes.len() as u64;
        // CUE-файл весит килобайты и приходит даже от «зависшей» раздачи образа.
        let is_cue = torrent_files(n)[file_index].0.ends_with(".cue");
        if self.stalled.lock().unwrap().contains(&n) && !is_cue {
            return Some(FileProgress {
                bytes_done: 0,
                bytes_total: total,
                peers: 0,
                down_speed_bps: 0,
                finished: false,
            });
        }
        let path = self.path(n, file_index);
        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
        }
        Some(FileProgress {
            bytes_done: total,
            bytes_total: total,
            peers: 1,
            down_speed_bps: 0,
            finished: true,
        })
    }

    fn file_path(&self, id: &TorrentHandleId, file_index: usize) -> Option<PathBuf> {
        Some(self.path(torrent_of(&id.0), file_index))
    }
}

// ------------------------------------------------------------------ паникующие хуки

/// Обёртка обработчика: первые вызовы `on_retry` и `on_exhausted` паникуют.
struct PanickyHooks {
    inner: Arc<dyn JobHandler>,
    retry_panics: Arc<AtomicUsize>,
    exhausted_panics: Arc<AtomicUsize>,
}

#[async_trait]
impl JobHandler for PanickyHooks {
    fn kinds(&self) -> &'static [&'static str] {
        self.inner.kinds()
    }
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        self.inner.handle(job, ctx).await
    }
    async fn on_retry(&self, job: &Job, ctx: &JobCtx, reason: &str) {
        if take(&self.retry_panics) {
            panic!("on_retry hook exploded (test)");
        }
        self.inner.on_retry(job, ctx, reason).await;
    }
    async fn on_exhausted(
        &self,
        job: &Job,
        ctx: &JobCtx,
        reason: &str,
        fatal: bool,
    ) -> Result<(), JobError> {
        if take(&self.exhausted_panics) {
            panic!("on_exhausted hook exploded (test)");
        }
        self.inner.on_exhausted(job, ctx, reason, fatal).await
    }
}

// ------------------------------------------------------------------ стенд

struct World {
    pool: PgPool,
    state: AppState,
    mb: MbClient,
    registry: Arc<ProviderRegistry>,
    swarm: Arc<Swarm>,
    settings: SettingsStore,
    retry_panics: Arc<AtomicUsize>,
    exhausted_panics: Arc<AtomicUsize>,
}

impl World {
    /// «Запуск процесса»: новый пул воркеров на той же БД (с `recover_orphans`), свежий контекст.
    async fn workers(&self) -> WorkerPool {
        let ctx = JobCtx::new(
            self.pool.clone(),
            self.state.events.clone(),
            self.mb.clone(),
            self.registry.clone(),
        )
        .with_fetcher(self.swarm.clone())
        .with_files(self.swarm.clone())
        .with_settings(self.settings.clone());
        let hs = handlers(&PerformanceSettings::default())
            .into_iter()
            .map(|(h, n)| {
                let wrapped: Arc<dyn JobHandler> = Arc::new(PanickyHooks {
                    inner: h,
                    retry_panics: self.retry_panics.clone(),
                    exhausted_panics: self.exhausted_panics.clone(),
                });
                (wrapped, n)
            })
            .collect();
        WorkerPool::start(
            ctx,
            hs,
            WorkerConfig {
                poll_interval: Duration::from_millis(30),
                backoff_base: Duration::from_millis(20),
                backoff_max: Duration::from_millis(200),
                heartbeat_interval: Duration::from_millis(200),
                stale_after: Duration::from_secs(2),
                maintenance_interval: Duration::from_millis(100),
                stuck_grace: Duration::from_millis(300),
                shutdown_timeout: Duration::from_secs(2),
                evict_interval: Some(Duration::from_millis(700)),
                retry_missing_interval: Some(Duration::from_millis(200)),
                restart_pause: Duration::from_millis(50),
                revive_delays: vec![Duration::from_millis(100)],
                invariants_interval: Some(Duration::from_millis(300)),
                invariants_grace: Duration::from_secs(5),
                // Минуты расписаний повторов сжаты в десятки миллисекунд.
                time_scale: 0.0005,
                ..WorkerConfig::default()
            },
        )
        .await
        .unwrap()
    }

    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }

    async fn wait(&self, what: &str, sql: &str) {
        let deadline = tokio::time::Instant::now() + LONG;
        loop {
            if self.count(sql).await > 0 {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("не дождались: {what}\n{}", self.dump().await);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Состояние БД для сообщения об ошибке.
    async fn dump(&self) -> String {
        let mut out = String::new();
        for (title, sql) in [
            ("tracks", "SELECT string_agg(a.title || '/' || t.position || ':' || t.status || COALESCE('(' || t.status_reason || ')', ''), ', ' ORDER BY a.id, t.position) FROM tracks t JOIN albums a ON a.id = t.album_id"),
            ("jobs", "SELECT string_agg(kind || ' ' || payload::text || ' ' || state || ' attempts=' || attempts || COALESCE(' err=' || last_error, ''), E'\n  ' ORDER BY id) FROM jobs WHERE state <> 'done'"),
            ("pins", "SELECT string_agg(track_id || ':' || state || COALESCE('(' || error || ')', '') || ' retries=' || retries, ', ' ORDER BY track_id) FROM pinned_tracks"),
            ("torrents", "SELECT string_agg(id || ':' || title || ' ' || meta_status || ' attempts=' || meta_attempts, E'\n  ' ORDER BY id) FROM torrents"),
            ("links", "SELECT string_agg(album_id || '-' || torrent_id || (CASE WHEN verified THEN ' ok' ELSE ' unverified' END), ', ' ORDER BY album_id, torrent_id) FROM album_torrents"),
            ("search", "SELECT string_agg(album_id || ':' || COALESCE(last_outcome, '-') || ' next=' || COALESCE(next_retry_at::text, '-'), ', ' ORDER BY album_id) FROM album_search_state"),
            ("cue", "SELECT string_agg(album_id || ':' || processed || '/' || failed, ', ') FROM cue_candidates"),
        ] {
            let v: Option<String> = sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap();
            out.push_str(&format!("{title}:\n  {}\n", v.unwrap_or_default()));
        }
        let report = invariants::check_all(&self.pool, &Params::new(Duration::ZERO))
            .await
            .unwrap();
        out.push_str(&format!("invariants: {:?}\n", report.sections));
        out
    }
}

/// Артист уже в библиотеке (MusicBrainz недоступен — через API его не добавить), импорт в очереди.
async fn add_artist(pool: &PgPool, a: u32) {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO artists (mbid, name, in_library, added_at) VALUES ($1::uuid, $2, TRUE, now())
         RETURNING id",
    )
    .bind(uuid_for('a', 0, a))
    .bind(artist_name(a))
    .fetch_one(pool)
    .await
    .unwrap();
    nimbus_library::enqueue_import_in(pool, id).await.unwrap();
}

/// Ускоритель времени для расписаний, которые живут в БД: авто-повтор поиска альбома «уже пора».
fn spawn_accelerator(pool: PgPool, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                () = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
            let _ = sqlx::query(
                "UPDATE album_search_state SET next_retry_at = now() WHERE next_retry_at > now()",
            )
            .execute(&pool)
            .await;
        }
    })
}

const BAND_TRACKS: &str = "FROM tracks t JOIN albums a ON a.id = t.album_id
     JOIN artists ar ON ar.id = a.artist_id WHERE ar.name = 'Chaos Band'";

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn everything_converges_under_failures(pool: PgPool) {
    // ---- стенд
    let root = nimbus_testkit::tempdir();
    let server = MockServer::start().await;
    let mb_down = Arc::new(AtomicBool::new(true));
    Mock::given(method("GET"))
        .respond_with(Mb {
            down: mb_down.clone(),
            refused: AtomicUsize::new(0),
        })
        .mount(&server)
        .await;
    let mut mcfg = MbConfig::new("NimbusTest/0.1 ( https://example.org/test )");
    mcfg.base = format!("{}/ws/2/", server.uri()).parse().unwrap();
    mcfg.lb_base = None;
    mcfg.limits = nimbus_musicbrainz::MbLimits::unlimited(8);
    mcfg.retry_delay = Duration::from_millis(5);
    let mb = MbClient::with_config(mcfg, None).unwrap();

    let provider = Arc::new(Provider::default());
    let registry = Arc::new(
        ProviderRegistry::new(vec![provider.clone() as Arc<dyn TorrentProvider>])
            .with_timeout(Duration::from_millis(300))
            .with_retries(0),
    );
    let swarm = Arc::new(Swarm {
        root: root.path().to_path_buf(),
        // Дискография: метаданные приходят только с третьей попытки.
        meta_timeouts: Mutex::new(HashMap::from([(T_DISCOGRAPHY, 2)])),
        meta_calls: Mutex::default(),
        // У образа с CUE сначала нет пиров совсем, потом они есть, но образ не отдают.
        offline: Mutex::new(HashSet::from([T_CUE])),
        // Раздача «Alpha Road» мертва насовсем: альбом должен скачаться из дискографии.
        stalled: Mutex::new(HashSet::from([T_ALPHA, T_CUE])),
        requested: Mutex::default(),
    });
    let mut defaults = nimbus_core::Settings::default();
    defaults.storage.auto_download = "added".into();
    let settings = SettingsStore::new(pool.clone(), defaults);
    let state = common::state_with_mb(pool.clone(), mb.clone())
        .with_files(swarm.clone())
        .with_providers(registry.clone())
        .with_settings(settings.clone());
    let w = World {
        pool: pool.clone(),
        state: state.clone(),
        mb,
        registry,
        swarm: swarm.clone(),
        settings,
        retry_panics: Arc::new(AtomicUsize::new(2)),
        exhausted_panics: Arc::new(AtomicUsize::new(1)),
    };
    // Провайдер: три ошибки сети и один зависший запрос (меньше порога предохранителя).
    provider.fail_left.store(3, Ordering::SeqCst);
    provider.hang_left.store(1, Ordering::SeqCst);

    let background = CancellationToken::new();
    let manager = spawn_download_manager_with(
        state.clone(),
        background.clone(),
        ManagerConfig {
            tick: Duration::from_millis(50),
            progress_every: Duration::from_millis(50),
            stall_timeout: Duration::from_millis(300),
            transient_pauses: vec![Duration::from_millis(100)],
            // Раздающий образа возвращается не сразу: цикл «нет сидов» не должен дойти до `dead`.
            stalled_pauses: vec![Duration::from_millis(150); 100_000],
            discover_interval: Duration::from_secs(1),
            restart_pause: Duration::from_millis(50),
        },
    );
    let watcher = spawn_watcher_with(
        state.clone(),
        background.clone(),
        Duration::from_millis(50),
        Duration::from_millis(50),
    );
    let accel_stop = CancellationToken::new();
    let accelerator = spawn_accelerator(pool.clone(), accel_stop.clone());

    // ---- MusicBrainz недоступен (5xx) дольше, чем у импорта попыток
    add_artist(&pool, 0).await;
    add_artist(&pool, 1).await;
    let first = w.workers().await;
    w.wait(
        "импорт исчерпал попытки и был оживлён",
        "SELECT count(*) FROM jobs WHERE kind = 'import_artist' AND revivals >= 1",
    )
    .await;
    mb_down.store(false, Ordering::SeqCst);
    w.wait(
        "альбомы импортированы",
        "SELECT (count(*) = 5)::int::bigint FROM albums WHERE in_library",
    )
    .await;

    // ---- «падение процесса» посреди задач: воркеры убиты, строки остались `running`
    w.wait(
        "есть выполняющаяся задача",
        "SELECT count(*) FROM jobs WHERE state = 'running'",
    )
    .await;
    drop(first);
    let second = w.workers().await;

    // ---- штатная остановка посреди работы и новый запуск
    w.wait(
        "первые треки найдены",
        &format!("SELECT count(*) {BAND_TRACKS} AND t.status IN ('found', 'ready')"),
    )
    .await;
    second.shutdown().await;
    let third = w.workers().await;

    // ---- образ с CUE: пиры появляются после того, как разбор уже повторялся
    w.wait(
        "разбор CUE повторялся или отложен до повтора альбома",
        "SELECT (SELECT count(*) FROM jobs WHERE kind = 'process_cue' AND attempts >= 2)
              + (SELECT count(*) FROM cue_candidates WHERE failed)",
    )
    .await;
    swarm.offline.lock().unwrap().clear();
    // ---- загрузка образа зависла; пир с данными приходит после первого цикла «нет сидов»
    w.wait(
        "закрепление образа прошло цикл stalled",
        "SELECT count(*) FROM pinned_tracks p JOIN tracks t ON t.id = p.track_id
           JOIN albums a ON a.id = t.album_id
         WHERE a.title = 'Delta Tide' AND p.retries >= 1",
    )
    .await;
    swarm.stalled.lock().unwrap().remove(&T_CUE);

    // ---- отказы сняты: всё, что есть в раздачах, скачано
    w.wait(
        "все треки Chaos Band скачаны, закрепления выполнены",
        &format!(
            "SELECT ((SELECT count(*) {BAND_TRACKS} AND t.in_library AND t.status = 'ready') = 12
                 AND (SELECT count(*) FROM pinned_tracks p JOIN tracks t ON t.id = p.track_id
                        JOIN albums a ON a.id = t.album_id JOIN artists ar ON ar.id = a.artist_id
                      WHERE ar.name = 'Chaos Band' AND p.state = 'done') = 12)::int::bigint"
        ),
    )
    .await;

    // ---- расписания больше не подгоняем: система должна успокоиться сама
    accel_stop.cancel();
    accelerator.await.unwrap();
    let deadline = tokio::time::Instant::now() + LONG;
    loop {
        // Работа есть, пока в очереди что-то кроме периодических задач или авто-повтор уже «пора»
        // (ускоритель мог успеть подогнать расписание перед остановкой).
        let busy = w
            .count(
                "SELECT (SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')
                           AND kind NOT IN ('retry_missing', 'evict_cache'))
                      + (SELECT count(*) FROM album_search_state WHERE next_retry_at <= now())
                      + (SELECT count(*) FROM tracks WHERE status = 'adding')",
            )
            .await;
        let solo_settled = w
            .count(
                "SELECT count(*) FROM tracks t JOIN albums a ON a.id = t.album_id
                   JOIN album_search_state s ON s.album_id = a.id
                 WHERE a.title = 'Hollow Ground' AND t.status = 'not_found'
                   AND t.status_reason = 'no_torrents' AND s.next_retry_at > now()",
            )
            .await;
        let report = invariants::check_all(&pool, &Params::new(Duration::ZERO))
            .await
            .unwrap();
        if busy == 0 && solo_settled == 3 && report.is_clean() {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("система не успокоилась\n{}", w.dump().await);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ---- итог
    assert_eq!(
        w.count("SELECT count(*) FROM jobs WHERE state = 'failed' AND NOT fatal")
            .await,
        0,
        "нерешённых неудач не осталось\n{}",
        w.dump().await
    );
    assert_eq!(
        w.count("SELECT count(*) FROM tracks WHERE status = 'adding'")
            .await,
        0
    );
    // «Alpha Road» скачан из дискографии: его собственная раздача так и не отдала ни байта.
    assert_eq!(
        w.count(
            "SELECT count(*) FROM track_sources ts
               JOIN tracks t ON t.id = ts.track_id JOIN albums a ON a.id = t.album_id
               JOIN torrents tr ON tr.id = ts.torrent_id
             WHERE a.title = 'Alpha Road' AND ts.is_primary AND tr.kind = 'discography'"
        )
        .await,
        3
    );
    // «Delta Tide» — три трека из одного образа.
    assert_eq!(
        w.count(
            "SELECT count(*) FROM track_sources ts
               JOIN tracks t ON t.id = ts.track_id JOIN albums a ON a.id = t.album_id
             WHERE a.title = 'Delta Tide' AND ts.is_primary AND ts.cue_start_ms IS NOT NULL"
        )
        .await,
        3
    );
    assert!(
        swarm.meta_calls.lock().unwrap()[&T_DISCOGRAPHY] >= 3,
        "метаданные дискографии получены после двух таймаутов"
    );
    assert_eq!(provider.fail_left.load(Ordering::SeqCst), 0);
    assert_eq!(provider.hang_left.load(Ordering::SeqCst), 0);
    assert_eq!(
        w.retry_panics.load(Ordering::SeqCst),
        0,
        "паникующий хук on_retry вызывался"
    );
    assert_eq!(
        w.exhausted_panics.load(Ordering::SeqCst),
        0,
        "паникующий хук on_exhausted вызывался"
    );
    assert_eq!(
        third.stats().restarts().total(),
        0,
        "паника хука не роняет циклы воркеров"
    );
    assert_eq!(third.stats().stuck(), 0, "периодическая проверка чиста");

    third.shutdown().await;
    background.cancel();
    manager.await.unwrap();
    watcher.await.unwrap();
}
