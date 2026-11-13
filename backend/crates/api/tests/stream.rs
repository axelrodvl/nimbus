// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{router, state};
use http_body_util::BodyExt;
use nimbus_api::stream::Watcher;
use nimbus_api::transcode::Transcoder;
use nimbus_api::AppState;
use nimbus_core::events::Event;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, downloads, torrents, track_sources, tracks};
use nimbus_torrent::{
    AsyncReadSeek, Bytes, EngineError, FileProgress, FileProvider, TorrentHandleId, TorrentRef,
};
use rand::RngCore;
use sqlx::PgPool;
use tokio::io::{AsyncRead, AsyncSeek, ReadBuf};
use tower::ServiceExt;
use uuid::Uuid;

const SIZE: usize = 300_000;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    Hang,
    EnsureTimeout,
    /// Первые байты отдаёт, потом «зависает».
    StallAfterFirst,
    EnsureStorage,
    OpenStorage,
}

struct Fake {
    path: PathBuf,
    mode: Mode,
    ensure_calls: AtomicUsize,
    open_calls: AtomicUsize,
    finished: AtomicBool,
    /// Сколько открытых читателей ещё не дропнуто.
    readers_alive: Arc<AtomicUsize>,
    /// Сколько ближайших вызовов `file_progress` паникуют.
    panics_left: AtomicUsize,
    bytes_done: AtomicU64,
    /// Что получил `ensure_file` (проверка: `.torrent` из БД доходит до движка).
    refs: std::sync::Mutex<Vec<TorrentRef>>,
    /// `.torrent`, который «движок получил из сети» при добавлении по magnet.
    engine_file: std::sync::Mutex<Option<Bytes>>,
}

impl Fake {
    fn new(path: PathBuf, mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            path,
            mode,
            ensure_calls: AtomicUsize::new(0),
            open_calls: AtomicUsize::new(0),
            finished: AtomicBool::new(false),
            readers_alive: Default::default(),
            panics_left: AtomicUsize::new(0),
            bytes_done: AtomicU64::new(0),
            refs: Default::default(),
            engine_file: Default::default(),
        })
    }
}

/// Читает маленькими порциями — как медленная раздача.
struct Slow {
    file: tokio::fs::File,
    /// После скольких отданных байт зависнуть (`None` — не зависать).
    stall_after: Option<usize>,
    given: usize,
    alive: Arc<AtomicUsize>,
}
impl Drop for Slow {
    fn drop(&mut self) {
        self.alive.fetch_sub(1, Ordering::SeqCst);
    }
}
impl AsyncRead for Slow {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.stall_after.is_some_and(|n| self.given >= n) {
            return Poll::Pending;
        }
        let n = buf.remaining().min(8 * 1024);
        let mut tmp = vec![0u8; n];
        let mut rb = ReadBuf::new(&mut tmp);
        let file = &mut self.file;
        match Pin::new(file).poll_read(cx, &mut rb) {
            Poll::Ready(Ok(())) => {
                self.given += rb.filled().len();
                buf.put_slice(rb.filled());
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
impl AsyncSeek for Slow {
    fn start_seek(mut self: Pin<&mut Self>, p: std::io::SeekFrom) -> std::io::Result<()> {
        Pin::new(&mut self.file).start_seek(p)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<u64>> {
        Pin::new(&mut self.file).poll_complete(cx)
    }
}

/// Никогда не отдаёт данные.
struct Hang;
impl AsyncRead for Hang {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Pending
    }
}
impl AsyncSeek for Hang {
    fn start_seek(self: Pin<&mut Self>, _: std::io::SeekFrom) -> std::io::Result<()> {
        Ok(())
    }
    fn poll_complete(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

#[async_trait]
impl FileProvider for Fake {
    async fn ensure_file(
        &self,
        torrent: &TorrentRef,
        _idx: usize,
    ) -> Result<TorrentHandleId, EngineError> {
        self.ensure_calls.fetch_add(1, Ordering::SeqCst);
        self.refs.lock().unwrap().push(torrent.clone());
        match self.mode {
            Mode::EnsureTimeout => return Err(EngineError::MetadataTimeout),
            Mode::EnsureStorage => return Err(EngineError::Storage("disk full".into())),
            _ => {}
        }
        Ok(TorrentHandleId(
            InfoHash::from_magnet(&torrent.magnet).unwrap(),
        ))
    }
    fn torrent_file(&self, _id: &TorrentHandleId) -> Option<Bytes> {
        self.engine_file.lock().unwrap().clone()
    }
    async fn open_stream(
        &self,
        _id: &TorrentHandleId,
        _idx: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        self.open_calls.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            Mode::Hang => return Ok(Box::new(Hang)),
            Mode::OpenStorage => return Err(EngineError::Storage("disk full".into())),
            _ => {}
        }
        self.readers_alive.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Slow {
            file: tokio::fs::File::open(&self.path).await?,
            stall_after: (self.mode == Mode::StallAfterFirst).then_some(8000),
            given: 0,
            alive: self.readers_alive.clone(),
        }))
    }
    fn file_progress(&self, _id: &TorrentHandleId, _idx: usize) -> Option<FileProgress> {
        if self
            .panics_left
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            panic!("injected panic in file_progress");
        }
        let fin = self.finished.load(Ordering::SeqCst);
        Some(FileProgress {
            bytes_done: if fin {
                SIZE as u64
            } else {
                self.bytes_done.load(Ordering::SeqCst)
            },
            bytes_total: SIZE as u64,
            peers: 3,
            down_speed_bps: 1000,
            finished: fin,
        })
    }
    fn file_path(&self, _id: &TorrentHandleId, _idx: usize) -> Option<PathBuf> {
        Some(self.path.clone())
    }
}

struct Fixture {
    pool: PgPool,
    track_id: i64,
    torrent_id: i64,
    content: Vec<u8>,
    path: PathBuf,
}

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{n:02x}").repeat(20)).unwrap()
}

async fn add_source(
    pool: &PgPool,
    track: &Track,
    album_id: i64,
    n: u8,
    ext: &str,
    score: f32,
    primary: bool,
) -> i64 {
    let t = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: hash(n),
            magnet: format!("magnet:?xt=urn:btih:{}", hash(n)),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: format!("t{n}"),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    torrents::replace_files(
        pool,
        t.id,
        &[NewTorrentFile {
            file_index: 0,
            path: format!("Album/01 - Song.{ext}"),
            size_bytes: SIZE as i64,
            ext: Some(ext.into()),
        }],
    )
    .await
    .unwrap();
    let src = track_sources::insert(
        pool,
        &NewTrackSource {
            track_id: track.id,
            torrent_id: t.id,
            file_index: 0,
            match_score: score,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    if primary {
        track_sources::set_primary(pool, track.id, src.id)
            .await
            .unwrap();
    }
    let _ = album_id;
    t.id
}

async fn fixture(pool: PgPool, ext: &str, status: TrackStatus) -> Fixture {
    let artist = artists::upsert_by_mbid(
        &pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "A".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    let album = albums::upsert_by_rg_mbid(
        &pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: artist.id,
            title: "B".into(),
            primary_type: None,
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let track = tracks::upsert_by_mbid_track(
        &pool,
        &NewTrack {
            mbid_recording: Uuid::new_v4(),
            mbid_track: None,
            album_id: album.id,
            artist_id: artist.id,
            title: "Song".into(),
            disc_no: 1,
            position: 1,
            duration_ms: None,
        },
    )
    .await
    .unwrap();
    tracks::set_status(&pool, track.id, status, None)
        .await
        .unwrap();
    let torrent_id = add_source(&pool, &track, album.id, 1, ext, 0.9, true).await;

    let mut content = vec![0u8; SIZE];
    rand::rng().fill_bytes(&mut content);
    let path = std::env::temp_dir().join(format!(
        "nimbus-stream-{}-{}.{ext}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::write(&path, &content).unwrap();
    Fixture {
        pool,
        track_id: track.id,
        torrent_id,
        content,
        path,
    }
}

struct Resp {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

async fn call(state: &AppState, method: &str, uri: &str, range: Option<&str>) -> Resp {
    call_h(state, method, uri, range, &[]).await
}

async fn call_h(
    state: &AppState,
    method: &str,
    uri: &str,
    range: Option<&str>,
    extra: &[(&str, &str)],
) -> Resp {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(r) = range {
        req = req.header("range", r);
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = router(state.clone())
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Resp {
        status,
        headers,
        body,
    }
}

fn h<'a>(r: &'a Resp, name: &str) -> &'a str {
    r.headers
        .get(name)
        .map(|v| v.to_str().unwrap())
        .unwrap_or("")
}

fn app(f: &Fixture, fake: &Arc<Fake>) -> AppState {
    state(f.pool.clone()).with_files(fake.clone())
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn full_and_partial_ranges(pool: PgPool) {
    let f = fixture(pool, "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let uri = format!("/api/tracks/{}/stream", f.track_id);

    let r = call(&st, "GET", &uri, None).await;
    assert_eq!(r.status, 200);
    assert_eq!(h(&r, "content-type"), "audio/flac");
    assert_eq!(h(&r, "accept-ranges"), "bytes");
    assert_eq!(h(&r, "cache-control"), "private, no-cache");
    assert_eq!(h(&r, "etag"), "", "файл ещё не завершён — ETag нет");
    assert_eq!(h(&r, "content-length"), SIZE.to_string());
    assert_eq!(r.body, f.content);

    let r = call(&st, "GET", &uri, Some("bytes=100-199")).await;
    assert_eq!(r.status, 206);
    assert_eq!(h(&r, "content-range"), format!("bytes 100-199/{SIZE}"));
    assert_eq!(h(&r, "content-length"), "100");
    assert_eq!(r.body, &f.content[100..200]);

    let r = call(&st, "GET", &uri, Some("bytes=-1000")).await;
    assert_eq!(r.status, 206);
    assert_eq!(
        h(&r, "content-range"),
        format!("bytes {}-{}/{SIZE}", SIZE - 1000, SIZE - 1)
    );
    assert_eq!(r.body, &f.content[SIZE - 1000..]);

    let r = call(&st, "GET", &uri, Some("bytes=250000-")).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &f.content[250_000..]);

    // Несколько диапазонов — первый.
    let r = call(&st, "GET", &uri, Some("bytes=0-9,20-29")).await;
    assert_eq!((r.status.as_u16(), r.body.len()), (206, 10));

    let r = call(&st, "GET", &uri, Some("bytes=999999-")).await;
    assert_eq!(r.status, 416);
    assert_eq!(h(&r, "content-range"), format!("bytes */{SIZE}"));
    let r = call(&st, "GET", &uri, Some("bytes=oops")).await;
    assert_eq!(r.status, 416);

    // Загрузка записана; last_played_at обновлён.
    let d = downloads::get(&f.pool, f.torrent_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.bytes_total, SIZE as i64);
    assert!(d.last_played_at.is_some() && d.completed_at.is_none());
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn head_does_not_touch_the_engine(pool: PgPool) {
    let f = fixture(pool, "mp3", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let r = call(
        &st,
        "HEAD",
        &format!("/api/tracks/{}/stream", f.track_id),
        Some("bytes=0-9"),
    )
    .await;
    assert_eq!(r.status, 206);
    assert_eq!(h(&r, "content-type"), "audio/mpeg");
    assert_eq!(h(&r, "content-length"), "10");
    assert!(r.body.is_empty());
    let r = call(
        &st,
        "HEAD",
        &format!("/api/tracks/{}/stream", f.track_id),
        None,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), h(&r, "content-length")),
        (200, SIZE.to_string().as_str())
    );
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 0);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn not_playable_and_unknown_track(pool: PgPool) {
    // adding → 409
    let f = fixture(pool.clone(), "flac", TrackStatus::Adding).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 409);
    assert!(String::from_utf8_lossy(&r.body).contains("track_not_playable"));
    assert_eq!(
        call(&st, "GET", "/api/tracks/99999/stream", None)
            .await
            .status,
        404
    );
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 0);

    let _ = std::fs::remove_file(&f.path);
}

/// Фальшивый `ffmpeg`: пишет аргументы и pid в файлы рядом, печатает несколько байт и зависает.
fn fake_ffmpeg(dir: &std::path::Path, hang: bool) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("ffmpeg");
    let tail = if hang { "exec sleep 30" } else { "" };
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo fake; exit 0; fi\n\
             echo \"$@\" > \"{d}/args\"\necho $$ > \"{d}/pid\"\nprintf 'fLaC-fake-output'\n{tail}\n",
            d = dir.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

fn temp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("nimbus-ffmpeg-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn complete_download(f: &Fixture) {
    downloads::upsert(
        &f.pool,
        &NewDownload {
            torrent_id: f.torrent_id,
            file_index: 0,
            local_path: f.path.to_string_lossy().into_owned(),
            bytes_total: SIZE as i64,
            bytes_done: SIZE as i64,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&f.pool, f.torrent_id, 0)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn transcode_is_unavailable_without_ffmpeg(pool: PgPool) {
    // ape и CUE-образ больше не дают 415/501: без ffmpeg — 503 `ffmpeg_missing`.
    let f = fixture(pool.clone(), "ape", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake); // ffmpeg по умолчанию «не найден»
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let r = call(&st, "GET", &uri, None).await;
    assert_eq!(r.status, 503);
    assert!(String::from_utf8_lossy(&r.body).contains("ffmpeg_missing"));

    let f2 = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    sqlx::query("UPDATE track_sources SET cue_start_ms = 1000 WHERE track_id = $1")
        .bind(f2.track_id)
        .execute(&pool)
        .await
        .unwrap();
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f2.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 503);
    for p in [&f.path, &f2.path] {
        let _ = std::fs::remove_file(p);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn transcode_streams_cue_segment_from_disk(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Ready).await;
    complete_download(&f).await;
    sqlx::query(
        "UPDATE track_sources SET cue_start_ms = 10000, cue_end_ms = 20000 WHERE track_id = $1",
    )
    .bind(f.track_id)
    .execute(&pool)
    .await
    .unwrap();
    let dir = temp_dir();
    let ffmpeg = fake_ffmpeg(&dir, false);
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = state(pool.clone())
        .with_files(fake.clone())
        .with_transcoder(Transcoder::new(ffmpeg).with_available(true));
    let uri = format!("/api/tracks/{}/stream", f.track_id);

    let r = call(&st, "GET", &uri, None).await;
    assert_eq!(r.status, 200);
    assert_eq!(h(&r, "content-type"), "audio/flac");
    assert_eq!(h(&r, "accept-ranges"), "none");
    assert_eq!(h(&r, "x-nimbus-transcode"), "1");
    assert_eq!(h(&r, "x-nimbus-duration-ms"), "10000");
    assert_eq!(r.body, b"fLaC-fake-output");
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains("-ss 10.000 -i "), "{args}");
    assert!(
        args.contains(&f.path.to_string_lossy().into_owned()),
        "{args}"
    );
    assert!(args.contains("-t 10.000"), "{args}");
    // Диск: движок не трогали.
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 0);

    // Перемотка: `?t=4` сдвигает начало и сокращает длительность.
    let r = call(&st, "GET", &format!("{uri}?t=4"), None).await;
    assert_eq!(r.status, 200);
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains("-ss 14.000 -i "), "{args}");
    assert!(args.contains("-t 6.000"), "{args}");

    // HEAD: заголовки без запуска ffmpeg.
    let _ = std::fs::remove_file(dir.join("args"));
    let r = call(&st, "HEAD", &uri, None).await;
    assert_eq!((r.status.as_u16(), h(&r, "x-nimbus-transcode")), (200, "1"));
    assert!(!dir.join("args").exists());
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn transcode_non_browser_format_has_no_segment(pool: PgPool) {
    let f = fixture(pool.clone(), "wv", TrackStatus::Ready).await;
    complete_download(&f).await;
    let dir = temp_dir();
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(Transcoder::new(fake_ffmpeg(&dir, false)).with_available(true));
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream?t=2.5", f.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains("-ss 2.500 -i "), "{args}");
    assert!(!args.contains(" -t "), "{args}");
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn dropping_the_response_kills_ffmpeg(pool: PgPool) {
    let f = fixture(pool.clone(), "wv", TrackStatus::Ready).await;
    complete_download(&f).await;
    let dir = temp_dir();
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(Transcoder::new(fake_ffmpeg(&dir, true)).with_available(true));
    let res = router(st.clone())
        .oneshot(
            Request::get(format!("/api/tracks/{}/stream", f.track_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let pid: u32 = std::fs::read_to_string(dir.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
    drop(res); // клиент закрыл соединение
    nimbus_testkit::eventually(std::time::Duration::from_secs(5), || async {
        !std::path::Path::new(&format!("/proc/{pid}")).exists()
    })
    .await; // ffmpeg должен быть убит при отключении клиента
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn transcoder_limits_concurrency(pool: PgPool) {
    let f = fixture(pool.clone(), "wv", TrackStatus::Ready).await;
    complete_download(&f).await;
    let dir = temp_dir();
    let tc = Transcoder::new(fake_ffmpeg(&dir, true)).with_available(true);
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(tc.clone());
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let mut held = vec![];
    for _ in 0..4 {
        let res = router(st.clone())
            .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        held.push(res);
    }
    let r = call(&st, "GET", &uri, None).await;
    assert_eq!(r.status, 503);
    assert!(String::from_utf8_lossy(&r.body).contains("transcoder_busy"));
    drop(held);
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Настоящий ffmpeg (пропускается, если его нет): образ 30 с + CUE на 3 трека по 10 с.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn real_ffmpeg_cue_segments_have_expected_duration(pool: PgPool) {
    let have = |bin: &str| {
        std::process::Command::new(bin)
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if !have("ffmpeg") || !have("ffprobe") {
        eprintln!("SKIPPED: ffmpeg/ffprobe not installed");
        return;
    }
    let f = fixture(pool.clone(), "flac", TrackStatus::Ready).await;
    let image = std::env::temp_dir().join(format!("nimbus-image-{}.flac", Uuid::new_v4()));
    let ok = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=d=30",
            "-c:a",
            "flac",
        ])
        .arg(&image)
        .status()
        .unwrap()
        .success();
    assert!(ok);
    let size = std::fs::metadata(&image).unwrap().len() as i64;
    sqlx::query("UPDATE torrent_files SET size_bytes = $2 WHERE torrent_id = $1")
        .bind(f.torrent_id)
        .bind(size)
        .execute(&pool)
        .await
        .unwrap();
    downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: f.torrent_id,
            file_index: 0,
            local_path: image.to_string_lossy().into_owned(),
            bytes_total: size,
            bytes_done: size,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&pool, f.torrent_id, 0)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE track_sources SET cue_start_ms = 10000, cue_end_ms = 20000 WHERE track_id = $1",
    )
    .bind(f.track_id)
    .execute(&pool)
    .await
    .unwrap();
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(Transcoder::new("ffmpeg").with_available(true));
    let probe = |bytes: &[u8]| -> f64 {
        let p = std::env::temp_dir().join(format!("nimbus-out-{}.flac", Uuid::new_v4()));
        std::fs::write(&p, bytes).unwrap();
        let out = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&p)
            .output()
            .unwrap();
        let _ = std::fs::remove_file(&p);
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    };
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let full = probe(&call(&st, "GET", &uri, None).await.body);
    assert!((full - 10.0).abs() < 0.5, "duration {full}");
    let half = probe(&call(&st, "GET", &format!("{uri}?t=5"), None).await.body);
    assert!((half - 5.0).abs() < 0.5, "duration {half}");
    let _ = std::fs::remove_file(&image);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn no_peers_gives_504_and_switches_primary_for_next_request(pool: PgPool) {
    for mode in [Mode::Hang, Mode::EnsureTimeout] {
        let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
        let track = tracks::get(&pool, f.track_id).await.unwrap().unwrap();
        let backup = add_source(
            &pool,
            &track,
            track.album_id,
            50 + mode as u8,
            "flac",
            0.7,
            false,
        )
        .await;
        let fake = Fake::new(f.path.clone(), mode);
        let mut st = app(&f, &fake);
        st.first_byte_timeout = Duration::from_millis(200);
        let uri = format!("/api/tracks/{}/stream", f.track_id);

        let r = call(&st, "GET", &uri, None).await;
        assert_eq!(r.status, 504);
        assert!(String::from_utf8_lossy(&r.body).contains("no_peers"));
        // Следующий запрос пойдёт через резервный источник.
        let p = track_sources::primary_for_track(&pool, f.track_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(p.torrent_id, backup);
        let _ = std::fs::remove_file(&f.path);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn watcher_marks_ready_and_next_request_is_served_from_disk(pool: PgPool) {
    let f = fixture(pool, "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let mut rx = st.events.subscribe();
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-9")).await.status, 206);
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 1);

    let mut w = Watcher::new();
    w.db_write_interval = None;
    // Прогресс без завершения: событие и bytes_done в БД.
    fake.bytes_done.store(1234, Ordering::SeqCst);
    w.tick(&st).await.unwrap();
    let d = downloads::get(&f.pool, f.torrent_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((d.bytes_done, d.completed_at.is_none()), (1234, true));
    // Без изменений — повторного события нет.
    w.tick(&st).await.unwrap();

    fake.finished.store(true, Ordering::SeqCst);
    w.tick(&st).await.unwrap();

    let d = downloads::get(&f.pool, f.torrent_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(d.completed_at.is_some());
    assert_eq!(d.bytes_done, SIZE as i64);
    assert_eq!(
        tracks::get(&f.pool, f.track_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        TrackStatus::Ready
    );

    let mut progress = 0;
    let mut ready = 0;
    while let Ok(e) = rx.try_recv() {
        match e {
            Event::StreamProgress {
                track_id,
                bytes_total,
                ..
            } => {
                assert_eq!((track_id, bytes_total), (f.track_id, SIZE as u64));
                progress += 1;
            }
            Event::TrackStatus {
                status: TrackStatus::Ready,
                ..
            } => ready += 1,
            _ => {}
        }
    }
    assert_eq!(progress, 2, "1234 байт и финальный прогресс, без дубля");
    assert_eq!(ready, 1);

    // Файл завершён: теперь отдаётся с диска, движок не нужен.
    let r = call(&st, "GET", &uri, Some("bytes=10-19")).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &f.content[10..20]);
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fake.open_calls.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn reconcile_resets_missing_completed_files(pool: PgPool) {
    let f = fixture(pool, "flac", TrackStatus::Ready).await;
    let missing = std::env::temp_dir().join(format!("nimbus-missing-{}", Uuid::new_v4()));
    downloads::upsert(
        &f.pool,
        &NewDownload {
            torrent_id: f.torrent_id,
            file_index: 0,
            local_path: missing.to_string_lossy().into_owned(),
            bytes_total: SIZE as i64,
            bytes_done: SIZE as i64,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&f.pool, f.torrent_id, 0)
        .await
        .unwrap();
    let st = state(f.pool.clone());
    let mut rx = st.events.subscribe();

    assert_eq!(
        nimbus_api::stream::reconcile_downloads(&st).await.unwrap(),
        1
    );
    let d = downloads::get(&f.pool, f.torrent_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(d.completed_at.is_none());
    assert_eq!(
        tracks::get(&f.pool, f.track_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        TrackStatus::Found
    );
    assert!(matches!(
        rx.try_recv(),
        Ok(Event::TrackStatus {
            status: TrackStatus::Found,
            ..
        })
    ));

    // Файл на месте — ничего не трогаем.
    downloads::upsert(
        &f.pool,
        &NewDownload {
            torrent_id: f.torrent_id,
            file_index: 0,
            local_path: f.path.to_string_lossy().into_owned(),
            bytes_total: SIZE as i64,
            bytes_done: SIZE as i64,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&f.pool, f.torrent_id, 0)
        .await
        .unwrap();
    assert_eq!(
        nimbus_api::stream::reconcile_downloads(&st).await.unwrap(),
        0
    );
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn internal_raw_serves_ranges_for_ffmpeg(pool: PgPool) {
    let f = fixture(pool.clone(), "ape", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let uri = format!("/api/internal/raw/{}/0", f.torrent_id);
    let tok = st.internal_token.to_string();
    let auth = [("x-nimbus-internal", tok.as_str())];
    let r = call_h(&st, "GET", &uri, Some("bytes=100-199"), &auth).await;
    assert_eq!(r.status, 206);
    assert_eq!(h(&r, "content-range"), format!("bytes 100-199/{SIZE}"));
    assert_eq!(r.body, &f.content[100..200]);
    assert!(!r
        .headers
        .values()
        .any(|v| v.to_str().unwrap_or("").contains(&tok)));
    assert_eq!(
        call_h(&st, "GET", "/api/internal/raw/999999/0", None, &auth)
            .await
            .status,
        404
    );
    assert_eq!(
        call_h(
            &st,
            "GET",
            &format!("/api/internal/raw/{}/9", f.torrent_id),
            None,
            &auth
        )
        .await
        .status,
        404
    );
    // Без токена и с неверным — 403, данные не отдаются.
    let r = call(&st, "GET", &uri, Some("bytes=0-9")).await;
    assert_eq!(r.status, 403);
    assert!(!r.body.starts_with(&f.content[..10]), "данные не отданы");
    for bad in ["wrong", "", &tok[..tok.len() - 1]] {
        let r = call_h(&st, "GET", &uri, None, &[("x-nimbus-internal", bad)]).await;
        assert_eq!(r.status, 403, "{bad}");
    }
    assert_eq!(tok.len(), 64);
    let _ = std::fs::remove_file(&f.path);
}

async fn post(st: &AppState, uri: &str) -> Resp {
    let res = router(st.clone())
        .oneshot(Request::post(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Resp {
        status,
        headers,
        body,
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn prefetch_registers_file_reads_head_and_protects_it(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let uri = format!("/api/tracks/{}/prefetch", f.track_id);

    let r = post(&st, &uri).await;
    assert_eq!(r.status, 202);
    assert!(String::from_utf8_lossy(&r.body).contains("started"));
    // Фоновая задача: ensure_file + open_stream, строка downloads создана.
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        fake.open_calls.load(Ordering::SeqCst) > 0
    })
    .await; // prefetch должен открыть поток
    assert!(fake.ensure_calls.load(Ordering::SeqCst) >= 1);
    assert!(downloads::get(&pool, f.torrent_id, 0)
        .await
        .unwrap()
        .is_some());
    assert!(st.activity.is_protected(f.torrent_id, 0));

    // Не `found` — нечего грузить; докачанный — `ready`.
    let a = fixture(pool.clone(), "flac", TrackStatus::Adding).await;
    let r = post(&st, &format!("/api/tracks/{}/prefetch", a.track_id)).await;
    assert!(String::from_utf8_lossy(&r.body).contains("skipped"));
    assert_eq!(post(&st, "/api/tracks/999999/prefetch").await.status, 404);
    let done = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    complete_download(&done).await;
    let r = post(&st, &format!("/api/tracks/{}/prefetch", done.track_id)).await;
    assert!(String::from_utf8_lossy(&r.body).contains("ready"));
    for p in [&f.path, &a.path, &done.path] {
        let _ = std::fs::remove_file(p);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stream_hands_the_stored_torrent_file_to_the_engine(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let uri = format!("/api/tracks/{}/stream", f.track_id);

    // В БД `.torrent` нет — движок получает только magnet.
    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-9")).await.status, 206);
    let first = fake.refs.lock().unwrap()[0].clone();
    assert_eq!(first.torrent_file, None);
    assert!(first.magnet.starts_with("magnet:?xt=urn:btih:"));

    // `.torrent` сохранён — тот же запрос передаёт байты (метаданные из сети не нужны).
    torrents::set_torrent_file(&pool, f.torrent_id, b"stored-torrent")
        .await
        .unwrap();
    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-9")).await.status, 206);
    let second = fake.refs.lock().unwrap()[1].clone();
    assert_eq!(second.torrent_file.as_deref(), Some(&b"stored-torrent"[..]));
    assert_eq!(second.magnet, first.magnet);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrent_file_received_by_the_engine_is_saved_once(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    *fake.engine_file.lock().unwrap() = Some(Bytes::from_static(b"from-engine"));
    let st = app(&f, &fake);
    let uri = format!("/api/tracks/{}/stream", f.track_id);

    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-9")).await.status, 206);
    assert_eq!(
        torrents::torrent_file(&pool, f.torrent_id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"from-engine"[..])
    );
    assert!(
        torrents::get(&pool, f.torrent_id)
            .await
            .unwrap()
            .unwrap()
            .has_torrent_file
    );

    // Файл уже есть в БД — байты движка его не перезаписывают.
    *fake.engine_file.lock().unwrap() = Some(Bytes::from_static(b"other"));
    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-9")).await.status, 206);
    assert_eq!(
        torrents::torrent_file(&pool, f.torrent_id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"from-engine"[..])
    );
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn prefetch_uses_and_saves_the_torrent_file(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    torrents::set_torrent_file(&pool, f.torrent_id, b"stored")
        .await
        .unwrap();
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let r = post(&st, &format!("/api/tracks/{}/prefetch", f.track_id)).await;
    assert_eq!(r.status, 202);
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        fake.open_calls.load(Ordering::SeqCst) > 0
    })
    .await;
    assert_eq!(
        fake.refs.lock().unwrap()[0].torrent_file.as_deref(),
        Some(&b"stored"[..])
    );

    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn prefetch_saves_the_torrent_file_received_by_the_engine(pool: PgPool) {
    let g = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake2 = Fake::new(g.path.clone(), Mode::Normal);
    *fake2.engine_file.lock().unwrap() = Some(Bytes::from_static(b"prefetched"));
    let st2 = app(&g, &fake2);
    let r = post(&st2, &format!("/api/tracks/{}/prefetch", g.track_id)).await;
    assert_eq!(r.status, 202);
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        torrents::torrent_file(&pool, g.torrent_id)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    assert_eq!(
        torrents::torrent_file(&pool, g.torrent_id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"prefetched"[..])
    );
    let _ = std::fs::remove_file(&g.path);
}

#[test]
fn prefetch_length_is_a_tenth_capped_at_two_megabytes() {
    use nimbus_api::stream::{prefetch_len, PREFETCH_MAX_BYTES};
    assert_eq!(prefetch_len(10_000), 1_000);
    assert_eq!(prefetch_len(100_000_000), PREFETCH_MAX_BYTES);
    assert_eq!(prefetch_len(5), 1);
    assert_eq!(prefetch_len(0), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn streaming_marks_the_file_active_until_the_body_is_dropped(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let res = router(st.clone())
        .oneshot(
            Request::get(format!("/api/tracks/{}/stream", f.track_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(st.activity.is_protected(f.torrent_id, 0));
    drop(res);
    assert!(!st.activity.is_protected(f.torrent_id, 0));
    let _ = std::fs::remove_file(&f.path);
}

// ------------------------------------------------------------ шаг 31

/// Тело ответа до ошибки: (собранные байты, ошибка).
async fn drain(res: axum::response::Response) -> (usize, Option<String>) {
    let mut body = res.into_body();
    let mut n = 0;
    loop {
        match body.frame().await {
            None => return (n, None),
            Some(Ok(f)) => n += f.into_data().map(|d| d.len()).unwrap_or(0),
            Some(Err(e)) => return (n, Some(e.to_string())),
        }
    }
}

async fn get_raw(st: &AppState, uri: &str, extra: &[(&str, &str)]) -> axum::response::Response {
    let mut req = Request::get(uri);
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    router(st.clone())
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn idle_stream_is_cut_and_the_source_is_switched(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let track = tracks::get(&pool, f.track_id).await.unwrap().unwrap();
    let backup = add_source(&pool, &track, track.album_id, 60, "flac", 0.7, false).await;
    let fake = Fake::new(f.path.clone(), Mode::StallAfterFirst);
    let mut st = app(&f, &fake);
    st.stream_idle_timeout = Duration::from_millis(100);
    let res = get_raw(&st, &format!("/api/tracks/{}/stream", f.track_id), &[]).await;
    assert_eq!(res.status(), 200);
    let (n, e) = drain(res).await;
    assert!(n > 0 && n < SIZE, "первый кусок пришёл, остальное нет: {n}");
    assert!(e.is_some(), "тело завершилось ошибкой");
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        track_sources::primary_for_track(&pool, f.track_id)
            .await
            .unwrap()
            .unwrap()
            .torrent_id
            == backup
    })
    .await;
    assert!(!st.activity.is_protected(f.torrent_id, 0), "защита снята");
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn client_disconnect_drops_the_engine_reader_and_the_activity_guard(pool: PgPool) {
    let f = fixture(pool, "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let res = get_raw(&st, &format!("/api/tracks/{}/stream", f.track_id), &[]).await;
    assert_eq!(res.status(), 200);
    assert_eq!(fake.readers_alive.load(Ordering::SeqCst), 1);
    assert!(st.activity.is_protected(f.torrent_id, 0));
    drop(res);
    assert_eq!(fake.readers_alive.load(Ordering::SeqCst), 0);
    assert!(!st.activity.is_protected(f.torrent_id, 0));
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn dropping_a_transcode_frees_the_slot(pool: PgPool) {
    let f = fixture(pool.clone(), "wv", TrackStatus::Ready).await;
    complete_download(&f).await;
    let dir = temp_dir();
    let tc = Transcoder::new(fake_ffmpeg(&dir, true)).with_available(true);
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(tc.clone());
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let mut held = vec![];
    for _ in 0..4 {
        held.push(get_raw(&st, &uri, &[]).await);
    }
    assert_eq!(call(&st, "GET", &uri, None).await.status, 503);
    drop(held);
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        let r = get_raw(&st, &uri, &[]).await;
        r.status() == 200
    })
    .await;
    assert!(!st.activity.is_protected(f.torrent_id, 0) || tc.limit.available_permits() <= 4);
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn transcode_gets_the_internal_secret_as_a_header_before_the_input(pool: PgPool) {
    let f = fixture(pool.clone(), "wv", TrackStatus::Found).await;
    let dir = temp_dir();
    let st = state(pool.clone())
        .with_files(Fake::new(f.path.clone(), Mode::Normal))
        .with_transcoder(
            Transcoder::new(fake_ffmpeg(&dir, false))
                .with_available(true)
                .with_raw_base("http://127.0.0.1:1"),
        );
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    let hdr = args.find("-headers").expect("-headers передан");
    assert!(hdr < args.find(" -i ").unwrap(), "{args}");
    assert!(args.contains(&format!("x-nimbus-internal: {}", st.internal_token)));
    assert!(!args.contains("?k="));
    // Секрета нет в теле и заголовках ответа.
    assert!(!String::from_utf8_lossy(&r.body).contains(&*st.internal_token));
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn internal_endpoint_is_not_in_openapi(_pool: PgPool) {
    let doc = serde_json::to_string(&<nimbus_api::openapi::ApiDoc as utoipa::OpenApi>::openapi())
        .unwrap();
    assert!(!doc.contains("/internal/"));
    assert!(!doc.to_lowercase().contains("x-nimbus-internal"));
    assert!(doc.contains("storage_error"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn range_edge_cases_over_http(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let st = app(&f, &Fake::new(f.path.clone(), Mode::Normal));
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let r = call(&st, "GET", &uri, Some("bytes=10-19")).await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_slice()),
        (206, &f.content[10..20])
    );
    let r = call(&st, "GET", &uri, Some("bytes=0-")).await;
    assert_eq!((r.status.as_u16(), r.body.len()), (206, SIZE));
    let r = call(&st, "GET", &uri, Some(&format!("bytes={SIZE}-"))).await;
    assert_eq!(r.status, 416);
    let r = call(&st, "GET", &uri, Some("bytes=-0")).await;
    assert_eq!(r.status, 416);
    // Неизвестная единица — игнорируется, отдаём целиком.
    let r = call(&st, "GET", &uri, Some("items=0-5")).await;
    assert_eq!((r.status.as_u16(), r.body.len()), (200, SIZE));
    // Пустой файл: GET/HEAD — 200 без тела, любой диапазон — 416.
    sqlx::query("UPDATE torrent_files SET size_bytes = 0")
        .execute(&pool)
        .await
        .unwrap();
    for m in ["GET", "HEAD"] {
        let r = call(&st, m, &uri, None).await;
        assert_eq!(
            (r.status.as_u16(), h(&r, "content-length")),
            (200, "0"),
            "{m}"
        );
        assert!(r.body.is_empty());
    }
    assert_eq!(call(&st, "GET", &uri, Some("bytes=0-")).await.status, 416);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn completed_file_has_etag_and_answers_304(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Ready).await;
    complete_download(&f).await;
    let st = state(pool.clone()).with_files(Fake::new(f.path.clone(), Mode::Normal));
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let r = call(&st, "GET", &uri, None).await;
    let etag = h(&r, "etag").to_string();
    assert!(etag.starts_with('"') && etag.len() > 4, "{etag}");
    assert_eq!(h(&r, "accept-ranges"), "bytes");
    assert_eq!(h(&r, "cache-control"), "private, no-cache");
    let same = call_h(&st, "GET", &uri, None, &[("if-none-match", &etag)]).await;
    assert_eq!(same.status, 304);
    assert!(same.body.is_empty());
    assert_eq!(h(&same, "etag"), etag);
    let weak = format!("\"zzz\", W/{etag}");
    assert_eq!(
        call_h(
            &st,
            "GET",
            &uri,
            Some("bytes=0-9"),
            &[("if-none-match", &weak)]
        )
        .await
        .status,
        304
    );
    assert_eq!(
        call_h(&st, "GET", &uri, None, &[("if-none-match", "*")])
            .await
            .status,
        304
    );
    let other = call_h(&st, "GET", &uri, None, &[("if-none-match", "\"nope\"")]).await;
    assert_eq!(other.status, 200);
    let head = call(&st, "HEAD", &uri, None).await;
    assert_eq!(h(&head, "etag"), etag);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn completed_file_gone_from_disk_goes_through_the_engine(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Ready).await;
    complete_download(&f).await;
    let moved = f.path.with_extension("moved");
    std::fs::rename(&f.path, &moved).unwrap();
    // Движок отдаёт тот же файл по своему пути.
    let fake = Fake::new(moved.clone(), Mode::Normal);
    let st = state(pool.clone()).with_files(fake.clone());
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f.track_id),
        Some("bytes=0-9"),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_slice()),
        (206, &f.content[..10])
    );
    assert_eq!(h(&r, "etag"), "");
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 1);
    let d = downloads::get(&pool, f.torrent_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(d.completed_at.is_none());
    let t = tracks::get(&pool, f.track_id).await.unwrap().unwrap();
    assert_eq!(t.status, TrackStatus::Found);
    // Файл другого размера — то же самое.
    std::fs::write(&f.path, b"x").unwrap();
    complete_download(&f).await;
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f.track_id),
        Some("bytes=0-9"),
    )
    .await;
    assert_eq!(r.status, 206);
    assert_eq!(fake.ensure_calls.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_file(&f.path);
    let _ = std::fs::remove_file(&moved);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn download_flag_sets_a_safe_content_disposition(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let st = app(&f, &Fake::new(f.path.clone(), Mode::Normal));
    let uri = format!("/api/tracks/{}/stream", f.track_id);
    let r = call(&st, "GET", &uri, None).await;
    assert_eq!(
        h(&r, "content-disposition"),
        "",
        "без download — как раньше"
    );
    let r = call(&st, "GET", &format!("{uri}?download=1"), None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, f.content);
    assert_eq!(
        h(&r, "content-disposition"),
        "attachment; filename=\"01 - Song.flac\"; filename*=UTF-8''01%20-%20Song.flac"
    );
    sqlx::query("UPDATE tracks SET title = $2 WHERE id = $1")
        .bind(f.track_id)
        .bind("Песня/../\"AC:DC\"?")
        .execute(&pool)
        .await
        .unwrap();
    let r = call(&st, "GET", &format!("{uri}?download=1"), None).await;
    let d = h(&r, "content-disposition").to_string();
    assert!(d.is_ascii(), "{d}");
    assert!(!d.contains('/') && !d.contains("\"AC"), "{d}");
    assert!(
        d.contains("filename*=UTF-8''01%20-%20%D0%9F%D0%B5%D1%81%D0%BD%D1%8F_.._"),
        "{d}"
    );
    // Файл защищён от вытеснения, пока тело живо.
    let res = get_raw(&st, &format!("{uri}?download=1"), &[]).await;
    assert!(st.activity.is_protected(f.torrent_id, 0));
    drop(res);
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn storage_errors_give_507(pool: PgPool) {
    for mode in [Mode::EnsureStorage, Mode::OpenStorage] {
        let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
        let st = app(&f, &Fake::new(f.path.clone(), mode));
        let r = call(
            &st,
            "GET",
            &format!("/api/tracks/{}/stream", f.track_id),
            None,
        )
        .await;
        assert_eq!(r.status, 507);
        assert!(String::from_utf8_lossy(&r.body).contains("storage_error"));
        let _ = std::fs::remove_file(&f.path);
    }
}

// ---- наблюдатель

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn watcher_survives_a_panic_and_stops_on_cancel(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    assert_eq!(
        call(
            &st,
            "GET",
            &format!("/api/tracks/{}/stream", f.track_id),
            Some("bytes=0-9")
        )
        .await
        .status,
        206
    );
    fake.panics_left.store(2, Ordering::SeqCst);
    fake.finished.store(true, Ordering::SeqCst);
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = nimbus_api::stream::spawn_watcher_with(
        st.clone(),
        cancel.clone(),
        Duration::from_millis(20),
        Duration::from_millis(20),
    );
    // Две паники позади — следующий тик довёл загрузку до конца.
    nimbus_testkit::eventually(Duration::from_secs(10), || async {
        downloads::get(&pool, f.torrent_id, 0)
            .await
            .unwrap()
            .unwrap()
            .completed_at
            .is_some()
    })
    .await;
    assert_eq!(fake.panics_left.load(Ordering::SeqCst), 0);
    assert!(!task.is_finished());
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn watcher_cancel_during_restart_pause_stops_it(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f.track_id),
        Some("bytes=0-9"),
    )
    .await;
    fake.panics_left.store(1000, Ordering::SeqCst);
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = nimbus_api::stream::spawn_watcher_with(
        st,
        cancel.clone(),
        Duration::from_millis(10),
        Duration::from_secs(3600),
    );
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        fake.panics_left.load(Ordering::SeqCst) < 1000
    })
    .await;
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let _ = std::fs::remove_file(&f.path);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn watcher_handles_fifty_downloads_with_correct_events(pool: PgPool) {
    let f = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    let fake = Fake::new(f.path.clone(), Mode::Normal);
    let st = app(&f, &fake);
    let track = tracks::get(&pool, f.track_id).await.unwrap().unwrap();
    // 49 дополнительных торрентов, у каждого — свой трек с primary на файл 0.
    let mut track_ids = vec![f.track_id];
    for n in 2..=50u8 {
        let t = tracks::upsert_by_mbid_track(
            &pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: track.album_id,
                artist_id: track.artist_id,
                title: format!("S{n}"),
                disc_no: 1,
                position: n as i32,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        tracks::set_status(&pool, t.id, TrackStatus::Found, None)
            .await
            .unwrap();
        let tid = add_source(&pool, &t, track.album_id, n, "flac", 0.9, true).await;
        downloads::upsert(
            &pool,
            &NewDownload {
                torrent_id: tid,
                file_index: 0,
                local_path: f.path.to_string_lossy().into_owned(),
                bytes_total: SIZE as i64,
                bytes_done: 0,
            },
        )
        .await
        .unwrap();
        track_ids.push(t.id);
    }
    downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: f.torrent_id,
            file_index: 0,
            local_path: f.path.to_string_lossy().into_owned(),
            bytes_total: SIZE as i64,
            bytes_done: 0,
        },
    )
    .await
    .unwrap();
    let mut rx = st.events.subscribe();
    let mut w = Watcher::new();
    w.db_write_interval = None;
    fake.bytes_done.store(500, Ordering::SeqCst);
    w.tick(&st).await.unwrap();
    fake.finished.store(true, Ordering::SeqCst);
    w.tick(&st).await.unwrap();

    let mut progress = std::collections::HashSet::new();
    let mut ready = std::collections::HashSet::new();
    while let Ok(e) = rx.try_recv() {
        match e {
            Event::StreamProgress { track_id, .. } => {
                progress.insert(track_id);
            }
            Event::TrackStatus {
                track_id,
                status: TrackStatus::Ready,
                ..
            } => {
                ready.insert(track_id);
            }
            _ => {}
        }
    }
    let all: std::collections::HashSet<i64> = track_ids.iter().copied().collect();
    assert_eq!(progress, all);
    assert_eq!(ready, all);
    assert!(downloads::list_active(&pool).await.unwrap().is_empty());
    let _ = std::fs::remove_file(&f.path);
}
