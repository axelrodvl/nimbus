// Интеграционные тесты менеджера загрузок (шаг 33): фейковый `FileProvider` с управляемым
// прогрессом и настоящий Postgres. unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use common::{get_json, request_json, router, state};
use nimbus_api::download_manager::{spawn_download_manager_with, DownloadManager, ManagerConfig};
use nimbus_api::stream::Watcher;
use nimbus_api::AppState;
use nimbus_core::events::Event;
use nimbus_core::model::*;
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::{albums, artists, downloads, pins, torrents, track_sources, tracks};
use nimbus_library::LibraryType;
use nimbus_torrent::{
    AsyncReadSeek, EngineError, FileProgress, FileProvider, TorrentHandleId, TorrentRef,
};
use serde_json::json;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Размер каждого файла в фейке.
const SIZE: u64 = 1000;

/// Управляемый `FileProvider`: прогресс задают тесты, вызовы записываются.
struct FakeFiles {
    root: PathBuf,
    done: Mutex<HashMap<(String, usize), u64>>,
    ensured: Mutex<Vec<(String, Vec<usize>)>>,
    paused: Mutex<HashSet<String>>,
    released: Mutex<Vec<(String, usize, bool)>>,
    fail_ensure: AtomicBool,
    /// Сколько ближайших `ensure_files` паникуют.
    panics_left: AtomicUsize,
    /// 0 — пауза/возобновление работают, 1 — торрента нет в движке, 2 — прочая ошибка.
    pause_mode: AtomicU8,
    fail_release: AtomicBool,
}

impl FakeFiles {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            root: std::env::temp_dir().join(format!("nimbus-dm-{}", Uuid::new_v4())),
            done: Mutex::default(),
            ensured: Mutex::default(),
            paused: Mutex::default(),
            released: Mutex::default(),
            fail_ensure: AtomicBool::new(false),
            panics_left: AtomicUsize::new(0),
            pause_mode: AtomicU8::new(0),
            fail_release: AtomicBool::new(false),
        })
    }

    fn set_done(&self, hash: &str, idx: usize, bytes: u64) {
        self.done
            .lock()
            .unwrap()
            .insert((hash.to_string(), idx), bytes);
    }

    fn complete(&self, hash: &str, idx: usize) {
        self.set_done(hash, idx, SIZE);
    }

    fn ensure_calls(&self) -> Vec<(String, Vec<usize>)> {
        self.ensured.lock().unwrap().clone()
    }

    fn paused(&self) -> HashSet<String> {
        self.paused.lock().unwrap().clone()
    }

    fn released(&self) -> Vec<(String, usize, bool)> {
        self.released.lock().unwrap().clone()
    }
}

impl Drop for FakeFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn hash_of(id: &TorrentHandleId) -> String {
    id.0.to_string()
}

#[async_trait]
impl FileProvider for FakeFiles {
    async fn ensure_file(
        &self,
        torrent: &TorrentRef,
        file_index: usize,
    ) -> Result<TorrentHandleId, EngineError> {
        self.ensure_files(torrent, &[file_index]).await
    }
    async fn ensure_files(
        &self,
        torrent: &TorrentRef,
        file_indexes: &[usize],
    ) -> Result<TorrentHandleId, EngineError> {
        if self
            .panics_left
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            panic!("injected panic in ensure_files");
        }
        if self.fail_ensure.load(Ordering::SeqCst) {
            return Err(EngineError::Storage("disk full".into()));
        }
        let id = TorrentHandleId(InfoHash::from_magnet(&torrent.magnet).unwrap());
        self.ensured
            .lock()
            .unwrap()
            .push((hash_of(&id), file_indexes.to_vec()));
        Ok(id)
    }
    async fn open_stream(
        &self,
        _id: &TorrentHandleId,
        _file_index: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        Err(EngineError::Internal("not used".into()))
    }
    fn file_progress(&self, id: &TorrentHandleId, file_index: usize) -> Option<FileProgress> {
        let done = self
            .done
            .lock()
            .unwrap()
            .get(&(hash_of(id), file_index))
            .copied()
            .unwrap_or(0);
        Some(FileProgress {
            bytes_done: done,
            bytes_total: SIZE,
            peers: 2,
            down_speed_bps: 500,
            finished: done >= SIZE,
        })
    }
    fn file_path(&self, id: &TorrentHandleId, file_index: usize) -> Option<PathBuf> {
        Some(
            self.root
                .join(hash_of(id))
                .join(format!("{file_index}.bin")),
        )
    }
    async fn pause_torrent(&self, id: &TorrentHandleId) -> Result<(), EngineError> {
        match self.pause_mode.load(Ordering::SeqCst) {
            1 => return Err(EngineError::NotFound),
            2 => return Err(EngineError::Internal("pause failed".into())),
            _ => {}
        }
        self.paused.lock().unwrap().insert(hash_of(id));
        Ok(())
    }
    async fn resume_torrent(&self, id: &TorrentHandleId) -> Result<(), EngineError> {
        match self.pause_mode.load(Ordering::SeqCst) {
            1 => return Err(EngineError::NotFound),
            2 => return Err(EngineError::Internal("resume failed".into())),
            _ => {}
        }
        self.paused.lock().unwrap().remove(&hash_of(id));
        Ok(())
    }
    async fn release_file(
        &self,
        id: &TorrentHandleId,
        file_index: usize,
        delete_data: bool,
    ) -> Result<(), EngineError> {
        if self.fail_release.load(Ordering::SeqCst) {
            return Err(EngineError::Internal("release failed".into()));
        }
        self.released
            .lock()
            .unwrap()
            .push((hash_of(id), file_index, delete_data));
        Ok(())
    }
}

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{n:02x}").repeat(20)).unwrap()
}

struct Seeded {
    album_id: i64,
    rg: Uuid,
    tracks: Vec<i64>,
    recordings: Vec<Uuid>,
    torrent_id: i64,
    hash: String,
}

async fn add_torrent(pool: &PgPool, n: u8, files: usize) -> i64 {
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
    let rows: Vec<NewTorrentFile> = (0..files)
        .map(|i| NewTorrentFile {
            file_index: i as i32,
            path: format!("Album/{:02} - Song.flac", i + 1),
            size_bytes: SIZE as i64,
            ext: Some("flac".into()),
        })
        .collect();
    torrents::replace_files(pool, t.id, &rows).await.unwrap();
    t.id
}

async fn add_source(
    pool: &PgPool,
    track_id: i64,
    torrent_id: i64,
    file_index: i32,
    score: f32,
    primary: bool,
) -> i64 {
    let src = track_sources::insert(
        pool,
        &NewTrackSource {
            track_id,
            torrent_id,
            file_index,
            match_score: score,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    if primary {
        track_sources::set_primary(pool, track_id, src.id)
            .await
            .unwrap();
    }
    src.id
}

/// Альбом из `files` треков в библиотеке; торрент `n` с primary-источниками (если `sources`).
async fn seed_with(
    pool: &PgPool,
    n: u8,
    files: usize,
    status: TrackStatus,
    sources: bool,
) -> Seeded {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "A".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    let rg = Uuid::new_v4();
    let album = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: rg,
            mbid_release: None,
            artist_id: artist.id,
            title: format!("Album {n}"),
            primary_type: None,
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let torrent_id = add_torrent(pool, n, files).await;
    let mut ids = vec![];
    let mut recordings = vec![];
    for i in 0..files {
        let rec = Uuid::new_v4();
        let track = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: rec,
                mbid_track: None,
                album_id: album.id,
                artist_id: artist.id,
                title: format!("Song {i}"),
                disc_no: 1,
                position: i as i32 + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        tracks::set_status(pool, track.id, status, None)
            .await
            .unwrap();
        if sources {
            add_source(pool, track.id, torrent_id, i as i32, 0.9, true).await;
        }
        ids.push(track.id);
        recordings.push(rec);
    }
    albums::set_in_library(pool, album.id, true).await.unwrap();
    tracks::set_in_library_for_album(pool, album.id, true)
        .await
        .unwrap();
    Seeded {
        album_id: album.id,
        rg,
        tracks: ids,
        recordings,
        torrent_id,
        hash: hash(n).to_string(),
    }
}

async fn seed(pool: &PgPool, n: u8, files: usize) -> Seeded {
    seed_with(pool, n, files, TrackStatus::Found, true).await
}

async fn pin_album(pool: &PgPool, album_id: i64) -> u64 {
    let mut c = pool.acquire().await.unwrap();
    pins::pin_album(&mut c, album_id).await.unwrap()
}

async fn pin_state(pool: &PgPool, track_id: i64) -> PinState {
    pins::get(pool, track_id).await.unwrap().unwrap().state
}

async fn pin_states(pool: &PgPool, ids: &[i64]) -> Vec<PinState> {
    let mut v = vec![];
    for &id in ids {
        v.push(pin_state(pool, id).await);
    }
    v
}

async fn status(pool: &PgPool, id: i64) -> TrackStatus {
    tracks::get(pool, id).await.unwrap().unwrap().status
}

fn cfg() -> ManagerConfig {
    ManagerConfig {
        tick: Duration::from_millis(20),
        progress_every: Duration::ZERO,
        stall_timeout: Duration::from_secs(3600),
        retry_after: Duration::from_secs(3600),
        max_retries: 5,
        restart_pause: Duration::from_millis(10),
    }
}

fn app_state(pool: &PgPool, files: &Arc<FakeFiles>) -> AppState {
    state(pool.clone()).with_files(files.clone())
}

/// Файлы, которые менеджер завёл в `downloads`, появляются на диске.
async fn touch_downloads(pool: &PgPool) {
    for d in downloads::list_all(pool).await.unwrap() {
        let p = PathBuf::from(&d.local_path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![1u8; SIZE as usize]).unwrap();
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pinned_album_is_downloaded_and_becomes_ready(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 3).await;
    assert_eq!(pin_album(&pool, a.album_id).await, 3);
    assert_eq!(
        pin_states(&pool, &a.tracks).await,
        vec![PinState::Queued; 3]
    );

    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    assert_eq!(
        pin_states(&pool, &a.tracks).await,
        vec![PinState::Downloading; 3]
    );
    // Все файлы торрента выбраны одним вызовом.
    assert_eq!(files.ensure_calls(), vec![(a.hash.clone(), vec![0, 1, 2])]);
    assert_eq!(downloads::list_all(&pool).await.unwrap().len(), 3);

    for i in 0..3 {
        files.complete(&a.hash, i);
    }
    Watcher::new().tick(&st).await.unwrap();
    for &t in &a.tracks {
        assert_eq!(status(&pool, t).await, TrackStatus::Ready);
    }
    m.tick().await.unwrap();
    assert_eq!(pin_states(&pool, &a.tracks).await, vec![PinState::Done; 3]);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn concurrency_limit_counts_torrents_not_files(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    st.settings
        .update(&json!({"performance": {"download_concurrency": 2}}))
        .await
        .unwrap();
    let mut albums_ = vec![];
    for n in 1..=5u8 {
        let a = seed(&pool, n, 2).await;
        pin_album(&pool, a.album_id).await;
        albums_.push(a);
    }
    let mut m = DownloadManager::new(st.clone(), cfg());

    let mut finished = 0;
    for _ in 0..20 {
        m.tick().await.unwrap();
        let mut active = vec![];
        for a in &albums_ {
            if pin_states(&pool, &a.tracks)
                .await
                .contains(&PinState::Downloading)
            {
                active.push(a);
            }
        }
        assert!(
            active.len() <= 2,
            "{} torrents active at once",
            active.len()
        );
        // Файлы одного торрента — одним ensure_files.
        for (_, idx) in files.ensure_calls() {
            assert_eq!(idx, vec![0, 1]);
        }
        for a in active {
            for i in 0..2 {
                files.complete(&a.hash, i);
            }
            finished += 1;
        }
        Watcher::new().tick(&st).await.unwrap();
        if finished == 5 {
            m.tick().await.unwrap();
            break;
        }
    }
    assert_eq!(files.ensure_calls().len(), 5);
    for a in &albums_ {
        assert_eq!(pin_states(&pool, &a.tracks).await, vec![PinState::Done; 2]);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_waits_for_a_source_and_starts_when_found(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed_with(&pool, 1, 1, TrackStatus::Adding, false).await;
    pin_album(&pool, a.album_id).await;
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::WaitingSource);

    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::WaitingSource);
    assert!(files.ensure_calls().is_empty());

    add_source(&pool, a.tracks[0], a.torrent_id, 0, 0.9, true).await;
    tracks::set_status(&pool, a.tracks[0], TrackStatus::Found, None)
        .await
        .unwrap();
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    assert_eq!(files.ensure_calls().len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn supervisor_wakes_on_found_event_and_on_notify_and_stops_on_cancel(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed_with(&pool, 1, 1, TrackStatus::Adding, false).await;
    pin_album(&pool, a.album_id).await;
    let cancel = CancellationToken::new();
    // Период тика — час: проснуться можно только по событию или будильнику.
    let handle = spawn_download_manager_with(
        st.clone(),
        cancel.clone(),
        ManagerConfig {
            tick: Duration::from_secs(3600),
            ..cfg()
        },
    );
    // Первый тик интервала срабатывает сразу: пин остаётся в ожидании источника.
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        pin_state(&pool, a.tracks[0]).await == PinState::WaitingSource
    })
    .await;

    add_source(&pool, a.tracks[0], a.torrent_id, 0, 0.9, true).await;
    set_track_status_and_publish(&pool, &st.events, a.tracks[0], TrackStatus::Found, None)
        .await
        .unwrap();
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        pin_state(&pool, a.tracks[0]).await == PinState::Downloading
    })
    .await;

    // Будильник API.
    let b = seed(&pool, 2, 1).await;
    pin_album(&pool, b.album_id).await;
    st.downloads.wake();
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        pin_state(&pool, b.tracks[0]).await == PinState::Downloading
    })
    .await;

    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("manager stops on cancel")
        .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stalled_file_switches_to_the_next_source_then_fails(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    let alt_torrent = add_torrent(&pool, 2, 1).await;
    add_source(&pool, a.tracks[0], alt_torrent, 0, 0.5, false).await;
    pin_album(&pool, a.album_id).await;
    let mut m = DownloadManager::new(
        st.clone(),
        ManagerConfig {
            stall_timeout: Duration::ZERO,
            ..cfg()
        },
    );

    m.tick().await.unwrap(); // старт с источника A
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    m.tick().await.unwrap(); // менеджер впервые замечает файл: отсчёт зависания начался
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    m.tick().await.unwrap(); // нет прогресса → источник B
    let primary = track_sources::primary_for_track(&pool, a.tracks[0])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(primary.torrent_id, alt_torrent);
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Queued);
    // Старый файл больше никому не нужен и снят с загрузки (данные не удаляются).
    assert!(files.released().contains(&(a.hash.clone(), 0, false)));

    m.tick().await.unwrap(); // старт с источника B
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    assert_eq!(files.ensure_calls().last().unwrap().0, hash(2).to_string());
    m.tick().await.unwrap();
    m.tick().await.unwrap(); // B тоже стоит, вернуться на A нельзя → failed
    let pin = pins::get(&pool, a.tracks[0]).await.unwrap().unwrap();
    assert_eq!(pin.state, PinState::Failed);
    assert_eq!(pin.error.as_deref(), Some("stalled"));

    // Причина видна в списке приобретения.
    let (code, v) = get_json(router(st), "/api/acquisition").await;
    assert_eq!(code, 200);
    let d = &v["items"][0]["download"];
    assert_eq!(d["state"], "failed");
    assert_eq!(d["error"], "stalled");
    assert_eq!(d["pinned"], true);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn failed_pins_are_retried_automatically_at_most_max_times(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let mut m = DownloadManager::new(
        st.clone(),
        ManagerConfig {
            stall_timeout: Duration::ZERO,
            retry_after: Duration::ZERO,
            max_retries: 2,
            ..cfg()
        },
    );
    for _ in 0..40 {
        m.tick().await.unwrap();
    }
    let pin = pins::get(&pool, a.tracks[0]).await.unwrap().unwrap();
    assert_eq!((pin.state, pin.retries), (PinState::Failed, 2));
    // Первая попытка и два повтора.
    assert_eq!(files.ensure_calls().len(), 3);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn failed_pin_waits_for_the_retry_interval(pool: PgPool) {
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    pins::set_state(&pool, a.tracks[0], PinState::Failed, Some("x"))
        .await
        .unwrap();
    assert!(pins::retry_failed(&pool, 3600.0, 5)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(pins::retry_failed(&pool, 0.0, 5).await.unwrap(), a.tracks);
    let pin = pins::get(&pool, a.tracks[0]).await.unwrap().unwrap();
    assert_eq!(
        (pin.state, pin.retries, pin.error),
        (PinState::Queued, 1, None)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn start_failure_marks_the_pin_failed_with_the_reason(pool: PgPool) {
    let files = FakeFiles::new();
    files.fail_ensure.store(true, Ordering::SeqCst);
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 2).await;
    pin_album(&pool, a.album_id).await;
    DownloadManager::new(st, cfg()).tick().await.unwrap();
    for &t in &a.tracks {
        let pin = pins::get(&pool, t).await.unwrap().unwrap();
        assert_eq!(pin.state, PinState::Failed);
        assert_eq!(pin.error.as_deref(), Some("storage: disk full"));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pause_all_stops_new_downloads_and_pauses_only_pin_torrents(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 1).await;
    let b = seed(&pool, 2, 1).await;
    pin_album(&pool, a.album_id).await;
    pin_album(&pool, b.album_id).await;
    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    assert_eq!(files.ensure_calls().len(), 2);

    // Файл торрента B сейчас играет: пауза его не трогает.
    let _guard = st.activity.begin_stream(b.torrent_id, 0);
    let (code, v) = request_json(app.clone(), "POST", "/api/downloads/pause-all", None).await;
    assert_eq!((code, &v["paused"]), (200, &json!(true)));
    let c = seed(&pool, 3, 1).await;
    pin_album(&pool, c.album_id).await;
    m.tick().await.unwrap();
    assert_eq!(files.paused(), HashSet::from([a.hash.clone()]));
    assert_eq!(
        files.ensure_calls().len(),
        2,
        "no new downloads while paused"
    );
    assert_eq!(pin_state(&pool, c.tracks[0]).await, PinState::Queued);

    // Флаг переживает рестарт: новый менеджер на той же БД ничего не стартует.
    assert!(nimbus_db::settings::downloads_paused(&pool).await.unwrap());
    let mut fresh = DownloadManager::new(st.clone(), cfg());
    fresh.tick().await.unwrap();
    assert_eq!(files.ensure_calls().len(), 2);

    let (code, v) = request_json(app, "POST", "/api/downloads/resume-all", None).await;
    assert_eq!((code, &v["paused"]), (200, &json!(false)));
    m.tick().await.unwrap();
    assert!(files.paused().is_empty(), "paused torrent was resumed");
    assert_eq!(pin_state(&pool, c.tracks[0]).await, PinState::Downloading);
    assert_eq!(files.ensure_calls().len(), 3);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn restart_requeues_downloading_pins_and_keeps_progress(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 2).await;
    pin_album(&pool, a.album_id).await;
    DownloadManager::new(st.clone(), cfg())
        .tick()
        .await
        .unwrap();
    files.set_done(&a.hash, 0, 600);

    assert_eq!(DownloadManager::startup(&st).await.unwrap(), 2);
    assert_eq!(
        pin_states(&pool, &a.tracks).await,
        vec![PinState::Queued; 2]
    );

    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    assert_eq!(
        pin_states(&pool, &a.tracks).await,
        vec![PinState::Downloading; 2]
    );
    // Повторный (идемпотентный) ensure_files; строки downloads не задвоились, прогресс не потерян.
    assert_eq!(files.ensure_calls().len(), 2);
    assert_eq!(downloads::list_all(&pool).await.unwrap().len(), 2);
    let p = files.file_progress(&TorrentHandleId(hash(1)), 0).unwrap();
    assert_eq!(p.bytes_done, 600);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unpin_keeps_completed_files_and_delete_files_removes_them(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 2).await;
    let uri = format!("/api/albums/{}/download", a.album_id);
    let mut m = DownloadManager::new(st.clone(), cfg());

    async fn download_all(
        m: &mut DownloadManager,
        st: &AppState,
        files: &FakeFiles,
        pool: &PgPool,
        a: &Seeded,
    ) {
        m.tick().await.unwrap();
        touch_downloads(pool).await;
        for i in 0..2 {
            files.complete(&a.hash, i);
        }
        Watcher::new().tick(st).await.unwrap();
        m.tick().await.unwrap();
        assert_eq!(pin_states(pool, &a.tracks).await, vec![PinState::Done; 2]);
    }

    let (code, v) = request_json(app.clone(), "POST", &uri, None).await;
    assert_eq!((code, &v["pinned"]), (200, &json!(2)));
    download_all(&mut m, &st, &files, &pool, &a).await;

    // Без `delete_files` файлы остаются, закрепление снято.
    let (code, _) = request_json(app.clone(), "DELETE", &uri, None).await;
    assert_eq!(code, 204);
    assert!(pins::get(&pool, a.tracks[0]).await.unwrap().is_none());
    assert_eq!(downloads::list_all(&pool).await.unwrap().len(), 2);
    for d in downloads::list_all(&pool).await.unwrap() {
        assert!(PathBuf::from(&d.local_path).exists());
    }
    assert_eq!(status(&pool, a.tracks[0]).await, TrackStatus::Ready);

    // С `delete_files=true` — удалены, треки снова `found`.
    let paths: Vec<String> = downloads::list_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|d| d.local_path)
        .collect();
    request_json(app.clone(), "POST", &uri, None).await;
    m.tick().await.unwrap();
    let (code, _) = request_json(app, "DELETE", &format!("{uri}?delete_files=true"), None).await;
    assert_eq!(code, 204);
    for p in paths {
        assert!(!PathBuf::from(p).exists());
    }
    assert!(downloads::list_all(&pool).await.unwrap().is_empty());
    for &t in &a.tracks {
        assert_eq!(status(&pool, t).await, TrackStatus::Found);
    }
    assert!(files.released().iter().any(|(_, _, delete)| *delete));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn shared_file_survives_while_another_track_is_still_pinned(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    // Два трека с primary на один и тот же файл (CUE-образ).
    let a = seed(&pool, 1, 1).await;
    let second = tracks::upsert_by_mbid_track(
        &pool,
        &NewTrack {
            mbid_recording: Uuid::new_v4(),
            mbid_track: None,
            album_id: a.album_id,
            artist_id: tracks::get(&pool, a.tracks[0])
                .await
                .unwrap()
                .unwrap()
                .artist_id,
            title: "Second".into(),
            disc_no: 1,
            position: 2,
            duration_ms: None,
        },
    )
    .await
    .unwrap();
    tracks::set_in_library(&pool, second.id, true)
        .await
        .unwrap();
    tracks::set_status(&pool, second.id, TrackStatus::Found, None)
        .await
        .unwrap();
    add_source(&pool, second.id, a.torrent_id, 0, 0.9, true).await;
    pin_album(&pool, a.album_id).await;

    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    touch_downloads(&pool).await;
    files.complete(&a.hash, 0);
    Watcher::new().tick(&st).await.unwrap();
    m.tick().await.unwrap();
    let path = PathBuf::from(&downloads::list_all(&pool).await.unwrap()[0].local_path);

    let (code, _) = request_json(
        app.clone(),
        "DELETE",
        &format!("/api/tracks/{}/download?delete_files=true", a.tracks[0]),
        None,
    )
    .await;
    assert_eq!(code, 204);
    assert!(path.exists(), "second track still needs the file");
    assert_eq!(status(&pool, second.id).await, TrackStatus::Ready);

    let (code, _) = request_json(
        app,
        "DELETE",
        &format!("/api/tracks/{}/download?delete_files=true", second.id),
        None,
    )
    .await;
    assert_eq!(code, 204);
    assert!(!path.exists());
    assert_eq!(status(&pool, second.id).await, TrackStatus::Found);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unpinning_an_unfinished_download_cancels_it(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    DownloadManager::new(st, cfg()).tick().await.unwrap();
    touch_downloads(&pool).await;
    files.set_done(&a.hash, 0, 300);

    let (code, _) = request_json(
        app,
        "DELETE",
        &format!("/api/albums/{}/download", a.album_id),
        None,
    )
    .await;
    assert_eq!(code, 204);
    assert!(files.released().contains(&(a.hash.clone(), 0, true)));
    assert!(downloads::list_all(&pool).await.unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changing_the_primary_source_requeues_the_pin(pool: PgPool) {
    let a = seed(&pool, 1, 1).await;
    let alt_torrent = add_torrent(&pool, 2, 1).await;
    let alt = add_source(&pool, a.tracks[0], alt_torrent, 0, 0.5, false).await;
    pin_album(&pool, a.album_id).await;
    pins::set_state(&pool, a.tracks[0], PinState::Done, None)
        .await
        .unwrap();
    track_sources::set_primary(&pool, a.tracks[0], alt)
        .await
        .unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Queued);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn download_progress_event_aggregates_files_once_per_torrent(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 2).await;
    pin_album(&pool, a.album_id).await;
    files.set_done(&a.hash, 0, 100);
    files.set_done(&a.hash, 1, 250);
    let mut rx = st.events.subscribe();
    DownloadManager::new(st.clone(), cfg())
        .tick()
        .await
        .unwrap();

    let mut got = None;
    while let Ok(ev) = rx.try_recv() {
        if let Event::DownloadProgress {
            album_id,
            bytes_done,
            bytes_total,
            down_bps,
            peers,
        } = ev
        {
            got = Some((album_id, bytes_done, bytes_total, down_bps, peers));
        }
    }
    // Скорость и пиры — торрента (не удваиваются по числу файлов), байты — сумма файлов.
    assert_eq!(got, Some((a.album_id, 350, 2 * SIZE, 500, 2)));

    let (_, v) = get_json(router(st), "/api/acquisition").await;
    let d = &v["items"][0]["download"];
    assert_eq!(d["state"], "downloading");
    assert_eq!(
        (d["down_bps"].as_u64(), d["peers"].as_u64()),
        (Some(500), Some(2))
    );
    assert_eq!(d["bytes_total"], 2 * SIZE);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_state_change_publishes_acquisition_changed(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let mut rx = st.events.subscribe();
    DownloadManager::new(st.clone(), cfg())
        .tick()
        .await
        .unwrap();
    let mut seen = false;
    while let Ok(ev) = rx.try_recv() {
        seen |= matches!(ev, Event::AcquisitionChanged { album_id } if album_id == a.album_id);
    }
    assert!(seen);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_endpoints_are_idempotent_and_validate(pool: PgPool) {
    let files = FakeFiles::new();
    let app = router(app_state(&pool, &files));
    let a = seed(&pool, 1, 2).await;
    let uri = format!("/api/albums/{}/download", a.album_id);

    for _ in 0..2 {
        let (code, v) = request_json(app.clone(), "POST", &uri, None).await;
        assert_eq!((code, &v["pinned"]), (200, &json!(2)));
    }
    let open = pins::list_open(&pool).await.unwrap();
    assert_eq!(open.len(), 2);
    assert!(open.iter().all(|p| p.state == PinState::Queued));
    assert!(
        pins::get(&pool, a.tracks[0])
            .await
            .unwrap()
            .unwrap()
            .album_pin
    );

    // Трек: идемпотентно, album_pin не сбрасывается.
    let t = format!("/api/tracks/{}/download", a.tracks[0]);
    let (code, v) = request_json(app.clone(), "POST", &t, None).await;
    assert_eq!((code, &v["pinned"]), (200, &json!(1)));
    assert!(
        pins::get(&pool, a.tracks[0])
            .await
            .unwrap()
            .unwrap()
            .album_pin
    );

    // Несуществующие сущности и трек вне библиотеки.
    for (method, uri) in [
        ("POST", "/api/albums/99999/download"),
        ("DELETE", "/api/albums/99999/download"),
        ("POST", "/api/tracks/99999/download"),
        ("DELETE", "/api/tracks/99999/download"),
    ] {
        let (code, v) = request_json(app.clone(), method, uri, None).await;
        assert_eq!(code, 404, "{method} {uri}");
        assert_eq!(v["error"]["code"], "not_found");
    }
    tracks::set_in_library(&pool, a.tracks[1], false)
        .await
        .unwrap();
    let (code, v) = request_json(
        app.clone(),
        "POST",
        &format!("/api/tracks/{}/download", a.tracks[1]),
        None,
    )
    .await;
    assert_eq!((code, &v["error"]["code"]), (409, &json!("not_in_library")));

    // Снятие идемпотентно.
    for _ in 0..2 {
        let (code, _) = request_json(app.clone(), "DELETE", &t, None).await;
        assert_eq!(code, 204);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pinning_a_failed_track_queues_it_again(pool: PgPool) {
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    pins::set_state(&pool, a.tracks[0], PinState::Failed, Some("stalled"))
        .await
        .unwrap();
    pin_album(&pool, a.album_id).await;
    let pin = pins::get(&pool, a.tracks[0]).await.unwrap().unwrap();
    assert_eq!((pin.state, pin.error), (PinState::Queued, None));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn auto_download_pins_what_is_added_to_the_library(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed_with(&pool, 1, 2, TrackStatus::NotFound, false).await;
    albums::set_in_library(&pool, a.album_id, false)
        .await
        .unwrap();
    tracks::set_in_library_for_album(&pool, a.album_id, false)
        .await
        .unwrap();

    // По умолчанию автозагрузка выключена.
    st.library.add_album(a.rg).await.unwrap();
    assert!(pins::get(&pool, a.tracks[0]).await.unwrap().is_none());
    st.library
        .remove(LibraryType::Album, a.album_id)
        .await
        .unwrap();

    st.settings
        .update(&json!({"storage": {"auto_download": "added"}}))
        .await
        .unwrap();
    st.library.add_album(a.rg).await.unwrap();
    for &t in &a.tracks {
        let pin = pins::get(&pool, t).await.unwrap().unwrap();
        assert_eq!((pin.state, pin.album_pin), (PinState::WaitingSource, true));
    }

    // Удаление из библиотеки снимает закрепления.
    st.library
        .remove(LibraryType::Album, a.album_id)
        .await
        .unwrap();
    assert!(pins::get(&pool, a.tracks[0]).await.unwrap().is_none());

    // Отдельный трек закрепляется без `album_pin`.
    albums::set_in_library(&pool, a.album_id, false)
        .await
        .unwrap();
    st.library
        .add_track(a.recordings[0], Some(a.rg))
        .await
        .unwrap();
    let pin = pins::get(&pool, a.tracks[0]).await.unwrap().unwrap();
    assert!(!pin.album_pin);
    assert!(pins::get(&pool, a.tracks[1]).await.unwrap().is_none());
    st.library
        .remove(LibraryType::Track, a.tracks[0])
        .await
        .unwrap();
    assert!(pins::get(&pool, a.tracks[0]).await.unwrap().is_none());

    // Удаление артиста снимает все закрепления его треков.
    pin_album(&pool, a.album_id).await;
    let artist_id = albums::get(&pool, a.album_id)
        .await
        .unwrap()
        .unwrap()
        .artist_id;
    st.library
        .remove(LibraryType::Artist, artist_id)
        .await
        .unwrap();
    assert!(pins::get(&pool, a.tracks[1]).await.unwrap().is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn storage_reports_pinned_bytes_and_over_limit(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 1).await;
    let dir = std::env::temp_dir().join(format!("nimbus-dm-storage-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("big.bin");
    // Разреженный файл чуть больше лимита кэша (1 ГБ): места на диске не занимает.
    let big = 1024u64 * 1024 * 1024 + 1;
    std::fs::File::create(&path).unwrap().set_len(big).unwrap();
    downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: a.torrent_id,
            file_index: 0,
            local_path: path.to_string_lossy().into_owned(),
            bytes_total: big as i64,
            bytes_done: big as i64,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&pool, a.torrent_id, 0)
        .await
        .unwrap();
    st.settings
        .update(&json!({"storage": {"cache_limit_gb": 1}}))
        .await
        .unwrap();

    let (_, v) = get_json(app.clone(), "/api/storage").await;
    assert_eq!(
        (
            v["pinned_bytes"].as_u64(),
            v["pinned_files"].as_u64(),
            &v["over_limit"]
        ),
        (Some(0), Some(0), &json!(false))
    );
    pin_album(&pool, a.album_id).await;
    let (_, v) = get_json(app, "/api/storage").await;
    assert_eq!(v["pinned_bytes"].as_u64(), Some(big));
    assert_eq!(v["pinned_files"], 1);
    assert_eq!(v["over_limit"], true);
    let _ = std::fs::remove_dir_all(&dir);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn supervisor_restarts_after_a_panicking_tick(pool: PgPool) {
    let files = FakeFiles::new();
    files.panics_left.store(1, Ordering::SeqCst);
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let cancel = CancellationToken::new();
    let handle = spawn_download_manager_with(st, cancel.clone(), cfg());
    // Первый тик паникует, после паузы менеджер создаётся заново и доводит дело до конца.
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        pin_state(&pool, a.tracks[0]).await == PinState::Downloading
    })
    .await;
    assert_eq!(files.ensure_calls().len(), 1);
    cancel.cancel();
    handle.await.unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn supervisor_requeues_downloading_pins_on_start(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    pins::set_state(&pool, a.tracks[0], PinState::Downloading, None)
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    // Параметры по умолчанию (тик раз в секунду): первый тик интервала срабатывает сразу.
    let handle = nimbus_api::download_manager::spawn_download_manager(st, cancel.clone());
    // Закрепление было `downloading` до «рестарта»: менеджер вернул его в очередь и стартовал заново.
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        !files.ensure_calls().is_empty()
            && pin_state(&pool, a.tracks[0]).await == PinState::Downloading
    })
    .await;
    cancel.cancel();
    handle.await.unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_a_file_provider_the_tick_does_nothing(pool: PgPool) {
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    DownloadManager::new(state(pool.clone()), cfg())
        .tick()
        .await
        .unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Queued);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn progress_resets_the_stall_timer(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let mut m = DownloadManager::new(
        st,
        ManagerConfig {
            stall_timeout: Duration::ZERO,
            ..cfg()
        },
    );
    m.tick().await.unwrap(); // старт
    m.tick().await.unwrap(); // отсчёт начат на 0 байт
    for bytes in [10, 20, 30] {
        files.set_done(&a.hash, 0, bytes);
        m.tick().await.unwrap();
        assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    }
    // Прогресс остановился — зависание.
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Failed);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_done_pin_whose_file_vanished_is_downloaded_again(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let mut m = DownloadManager::new(st.clone(), cfg());
    m.tick().await.unwrap();
    files.complete(&a.hash, 0);
    Watcher::new().tick(&st).await.unwrap();
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Done);

    // Файл пропал с диска: загрузка сброшена, трек `ready → found`.
    downloads::reset_completed(&pool, a.torrent_id, 0)
        .await
        .unwrap();
    tracks::set_status(&pool, a.tracks[0], TrackStatus::Found, None)
        .await
        .unwrap();
    files.set_done(&a.hash, 0, 0);
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    assert_eq!(files.ensure_calls().len(), 2);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_pin_with_a_source_waits_for_a_slot_as_queued(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    st.settings
        .update(&json!({"performance": {"download_concurrency": 1}}))
        .await
        .unwrap();
    let a = seed(&pool, 1, 1).await;
    let b = seed(&pool, 2, 1).await;
    pin_album(&pool, a.album_id).await;
    pin_album(&pool, b.album_id).await;
    // Второй закреплён, пока источника не было, и успел стать `waiting_source`.
    pins::set_state(&pool, b.tracks[0], PinState::WaitingSource, None)
        .await
        .unwrap();
    DownloadManager::new(st, cfg()).tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
    assert_eq!(pin_state(&pool, b.tracks[0]).await, PinState::Queued);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_goes_back_to_waiting_when_the_track_loses_its_source(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    tracks::set_status(&pool, a.tracks[0], TrackStatus::Adding, None)
        .await
        .unwrap();
    DownloadManager::new(st, cfg()).tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::WaitingSource);
    assert!(files.ensure_calls().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_new_pin_joins_an_active_torrent_without_taking_a_slot(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    st.settings
        .update(&json!({"performance": {"download_concurrency": 1}}))
        .await
        .unwrap();
    let a = seed(&pool, 1, 2).await;
    let b = seed(&pool, 2, 1).await;
    pins::pin_tracks(&pool, &a.tracks[..1], false)
        .await
        .unwrap();
    let mut m = DownloadManager::new(st, cfg());
    m.tick().await.unwrap();
    pins::pin_tracks(&pool, &a.tracks[1..], false)
        .await
        .unwrap();
    pin_album(&pool, b.album_id).await;
    m.tick().await.unwrap();

    // Второй файл того же торрента стартовал, чужой торрент ждёт свободного слота.
    assert_eq!(
        files.ensure_calls(),
        vec![(a.hash.clone(), vec![0]), (a.hash.clone(), vec![1])]
    );
    assert_eq!(pin_state(&pool, b.tracks[0]).await, PinState::Queued);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pause_and_resume_errors_do_not_break_the_manager(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 1).await;
    pin_album(&pool, a.album_id).await;
    let mut m = DownloadManager::new(st, cfg());
    m.tick().await.unwrap();
    request_json(app.clone(), "POST", "/api/downloads/pause-all", None).await;

    // Торрента нет в движке и прочая ошибка: пауза не записывается, менеджер живёт.
    for mode in [1, 2] {
        files.pause_mode.store(mode, Ordering::SeqCst);
        m.tick().await.unwrap();
        assert!(files.paused().is_empty());
    }
    files.pause_mode.store(0, Ordering::SeqCst);
    m.tick().await.unwrap();
    assert_eq!(files.paused(), HashSet::from([a.hash.clone()]));

    // Возобновление с ошибкой логируется и не роняет тик.
    files.pause_mode.store(2, Ordering::SeqCst);
    request_json(app, "POST", "/api/downloads/resume-all", None).await;
    m.tick().await.unwrap();
    assert_eq!(pin_state(&pool, a.tracks[0]).await, PinState::Downloading);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unpin_survives_engine_and_disk_errors(pool: PgPool) {
    let files = FakeFiles::new();
    let st = app_state(&pool, &files);
    let app = router(st.clone());
    let a = seed(&pool, 1, 2).await;
    pin_album(&pool, a.album_id).await;
    DownloadManager::new(st.clone(), cfg())
        .tick()
        .await
        .unwrap();
    files.complete(&a.hash, 0);
    files.complete(&a.hash, 1);
    Watcher::new().tick(&st).await.unwrap();
    // Файл 0 — обычный; файл 1 «не удаляется»: на его месте непустой каталог.
    let rows = downloads::list_all(&pool).await.unwrap();
    for d in &rows {
        let p = PathBuf::from(&d.local_path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        if d.file_index == 0 {
            std::fs::write(&p, b"x").unwrap();
        } else {
            std::fs::create_dir_all(p.join("inner")).unwrap();
        }
    }
    files.fail_release.store(true, Ordering::SeqCst);

    let (code, _) = request_json(
        app,
        "DELETE",
        &format!("/api/albums/{}/download?delete_files=true", a.album_id),
        None,
    )
    .await;
    assert_eq!(code, 204);
    // Ошибка движка не мешает удалить файл с диска; ошибка диска оставляет строку и статус.
    let left = downloads::list_all(&pool).await.unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].file_index, 1);
    assert_eq!(status(&pool, a.tracks[0]).await, TrackStatus::Found);
    assert_eq!(status(&pool, a.tracks[1]).await, TrackStatus::Ready);
}
