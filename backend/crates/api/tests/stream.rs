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
use nimbus_api::AppState;
use nimbus_core::events::Event;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, downloads, torrents, track_sources, tracks};
use nimbus_torrent::{AsyncReadSeek, EngineError, FileProgress, FileProvider, TorrentHandleId};
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
}

struct Fake {
    path: PathBuf,
    mode: Mode,
    ensure_calls: AtomicUsize,
    open_calls: AtomicUsize,
    finished: AtomicBool,
    bytes_done: AtomicU64,
}

impl Fake {
    fn new(path: PathBuf, mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            path,
            mode,
            ensure_calls: AtomicUsize::new(0),
            open_calls: AtomicUsize::new(0),
            finished: AtomicBool::new(false),
            bytes_done: AtomicU64::new(0),
        })
    }
}

/// Читает маленькими порциями — как медленная раздача.
struct Slow(tokio::fs::File);
impl AsyncRead for Slow {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let n = buf.remaining().min(8 * 1024);
        let mut tmp = vec![0u8; n];
        let mut rb = ReadBuf::new(&mut tmp);
        match Pin::new(&mut self.0).poll_read(cx, &mut rb) {
            Poll::Ready(Ok(())) => {
                buf.put_slice(rb.filled());
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
impl AsyncSeek for Slow {
    fn start_seek(mut self: Pin<&mut Self>, p: std::io::SeekFrom) -> std::io::Result<()> {
        Pin::new(&mut self.0).start_seek(p)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<u64>> {
        Pin::new(&mut self.0).poll_complete(cx)
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
    async fn ensure_file(&self, magnet: &str, _idx: usize) -> Result<TorrentHandleId, EngineError> {
        self.ensure_calls.fetch_add(1, Ordering::SeqCst);
        if self.mode == Mode::EnsureTimeout {
            return Err(EngineError::MetadataTimeout);
        }
        Ok(TorrentHandleId(InfoHash::from_magnet(magnet).unwrap()))
    }
    async fn open_stream(
        &self,
        _id: &TorrentHandleId,
        _idx: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        self.open_calls.fetch_add(1, Ordering::SeqCst);
        if self.mode == Mode::Hang {
            return Ok(Box::new(Hang));
        }
        Ok(Box::new(Slow(tokio::fs::File::open(&self.path).await?)))
    }
    fn file_progress(&self, _id: &TorrentHandleId, _idx: usize) -> Option<FileProgress> {
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
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(r) = range {
        req = req.header("range", r);
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
    assert_eq!(h(&r, "cache-control"), "no-store");
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
async fn not_playable_unsupported_and_cue(pool: PgPool) {
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

    // ape → 415
    let f2 = fixture(pool.clone(), "ape", TrackStatus::Found).await;
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f2.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 415);
    assert!(String::from_utf8_lossy(&r.body).contains("transcode_required"));

    // CUE → 501
    let f3 = fixture(pool.clone(), "flac", TrackStatus::Found).await;
    sqlx::query("UPDATE track_sources SET cue_start_ms = 1000 WHERE track_id = $1")
        .bind(f3.track_id)
        .execute(&pool)
        .await
        .unwrap();
    let r = call(
        &st,
        "GET",
        &format!("/api/tracks/{}/stream", f3.track_id),
        None,
    )
    .await;
    assert_eq!(r.status, 501);
    assert!(String::from_utf8_lossy(&r.body).contains("cue_not_supported"));
    for p in [&f.path, &f2.path, &f3.path] {
        let _ = std::fs::remove_file(p);
    }
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
