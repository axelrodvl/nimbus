// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nimbus_core::events::{Event, EventBus, JobStage};
use nimbus_core::jobs::Job;
use nimbus_core::model::*;
use nimbus_db::repo::jobs::EnqueueOpts;
use nimbus_db::repo::{
    album_torrents, albums, artists, cue_candidates, jobs, torrents, track_sources, tracks,
};
use nimbus_torrent::{EngineError, FileEntry, MetadataFetcher, TorrentMeta};
use nimbus_worker::verify::{verify_torrent, VerifyHandler};
use nimbus_worker::{JobCtx, JobError, JobHandler};
use sqlx::PgPool;
use uuid::Uuid;

const OK: [&str; 4] = [
    "Airbag",
    "Paranoid Android",
    "Subterranean Homesick Alien",
    "Exit Music",
];

enum Reply {
    Files(Vec<(&'static str, u64)>),
    Timeout,
    Invalid,
}

struct FakeFetcher {
    replies: Mutex<std::collections::HashMap<String, Reply>>,
    calls: AtomicUsize,
}

impl FakeFetcher {
    fn new(replies: Vec<(InfoHash, Reply)>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(
                replies
                    .into_iter()
                    .map(|(h, r)| (h.to_string(), r))
                    .collect(),
            ),
            calls: AtomicUsize::new(0),
        })
    }
}

#[async_trait]
impl MetadataFetcher for FakeFetcher {
    async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let hash = InfoHash::from_magnet(magnet).unwrap();
        let replies = self.replies.lock().unwrap();
        match replies.get(hash.as_str()) {
            Some(Reply::Files(fs)) => Ok(TorrentMeta {
                info_hash: hash,
                name: "t".into(),
                piece_length: 16384,
                files: fs
                    .iter()
                    .enumerate()
                    .map(|(i, (p, s))| FileEntry {
                        index: i,
                        path: p.to_string(),
                        size: *s,
                    })
                    .collect(),
            }),
            Some(Reply::Timeout) => Err(EngineError::MetadataTimeout),
            Some(Reply::Invalid) => Err(EngineError::InvalidMagnet("bad".into())),
            None => Err(EngineError::NotFound),
        }
    }
}

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{n:02x}").repeat(20)).unwrap()
}

fn ctx(pool: &PgPool, fetcher: Arc<FakeFetcher>) -> (JobCtx, EventBus) {
    let events = EventBus::new();
    let ctx = JobCtx::new(
        pool.clone(),
        events.clone(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
    .with_fetcher(fetcher);
    (ctx, events)
}

struct Setup {
    album_id: i64,
    track_ids: Vec<i64>,
}

async fn setup(pool: &PgPool, titles: &[&str]) -> Setup {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Radiohead".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    let album = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: artist.id,
            title: "OK Computer".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(1997),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let mut track_ids = vec![];
    for (i, t) in titles.iter().enumerate() {
        let tr = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: album.id,
                artist_id: artist.id,
                title: t.to_string(),
                disc_no: 1,
                position: i as i32 + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        track_ids.push(tr.id);
    }
    albums::set_in_library(pool, album.id, true).await.unwrap();
    tracks::set_in_library_for_album(pool, album.id, true)
        .await
        .unwrap();
    Setup {
        album_id: album.id,
        track_ids,
    }
}

async fn add_torrent(pool: &PgPool, album_id: i64, n: u8, rank: f32) -> i64 {
    let t = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: hash(n),
            magnet: format!("magnet:?xt=urn:btih:{}", hash(n)),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: format!("torrent {n}"),
            size_bytes: None,
            seeders: Some(10),
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    album_torrents::link(pool, album_id, t.id, "q", rank)
        .await
        .unwrap();
    t.id
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn good_files() -> Vec<(&'static str, u64)> {
    let mut v: Vec<(&'static str, u64)> = OK
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                leak(format!(
                    "Radiohead - OK Computer (1997) [FLAC]/{:02} - {t}.flac",
                    i + 1
                )),
                30_000_000,
            )
        })
        .collect();
    v.push(("Radiohead - OK Computer (1997) [FLAC]/cover.jpg", 100_000));
    v
}

async fn statuses(pool: &PgPool, album_id: i64) -> Vec<(TrackStatus, Option<String>)> {
    tracks::list_by_album(pool, album_id)
        .await
        .unwrap()
        .into_iter()
        .map(|t| (t.status, t.status_reason))
        .collect()
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<Event>) -> Vec<Event> {
    let mut v = vec![];
    while let Ok(e) = rx.try_recv() {
        v.push(e);
    }
    v
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_torrent_marks_all_tracks_found_with_one_primary(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let tid = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let fetcher = FakeFetcher::new(vec![(hash(1), Reply::Files(good_files()))]);
    let (ctx, events) = ctx(&pool, fetcher.clone());
    let mut rx = events.subscribe();

    verify_torrent(&ctx, tid, s.album_id).await.unwrap();

    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!((st, reason), (TrackStatus::Found, None));
    }
    for id in &s.track_ids {
        let srcs = track_sources::list_for_track(&pool, *id).await.unwrap();
        assert_eq!(srcs.len(), 1);
        assert!(
            srcs[0].is_primary && !srcs[0].needs_confirmation,
            "{srcs:?}"
        );
        assert_eq!(srcs[0].torrent_id, tid);
    }
    // Файлы сохранены, расширения в нижнем регистре; торрент `ok`.
    let files = torrents::files(&pool, tid).await.unwrap();
    assert_eq!(files.len(), 5);
    assert_eq!(files[0].ext.as_deref(), Some("flac"));
    assert_eq!(
        torrents::get(&pool, tid)
            .await
            .unwrap()
            .unwrap()
            .meta_status,
        MetaStatus::Ok
    );
    assert_eq!(
        album_torrents::count_unverified(&pool, s.album_id)
            .await
            .unwrap(),
        0
    );

    let evs = drain(&mut rx);
    let found = evs
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::TrackStatus {
                    status: TrackStatus::Found,
                    ..
                }
            )
        })
        .count();
    assert_eq!(found, 4);
    let progress: Vec<_> = evs
        .iter()
        .filter_map(|e| match e {
            Event::JobProgress {
                stage: JobStage::Verifying,
                done,
                total,
                ..
            } => Some((*done, *total)),
            _ => None,
        })
        .collect();
    assert_eq!(progress.first(), Some(&(0, 1)));
    assert_eq!(progress.last(), Some(&(1, 1)));

    // Повтор: источники не дублируются, fetcher не вызывается (meta_status = ok).
    verify_torrent(&ctx, tid, s.album_id).await.unwrap();
    assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        track_sources::list_for_track(&pool, s.track_ids[0])
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn timeouts_retry_then_dead_then_not_found_dead_torrents(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let tid = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let fetcher = FakeFetcher::new(vec![(hash(1), Reply::Timeout)]);
    let (ctx, events) = ctx(&pool, fetcher);
    let mut rx = events.subscribe();

    for attempt in 1..=2 {
        match verify_torrent(&ctx, tid, s.album_id).await {
            Err(JobError::Retry { after, .. }) => assert_eq!(after.as_secs(), 900 * attempt),
            other => panic!("attempt {attempt}: expected Retry, got {other:?}"),
        }
        let t = torrents::get(&pool, tid).await.unwrap().unwrap();
        assert_eq!(
            (t.meta_status, t.meta_attempts),
            (MetaStatus::Timeout, attempt as i32)
        );
        // Пока не проверена — треки ждут.
        for (st, _) in statuses(&pool, s.album_id).await {
            assert_eq!(st, TrackStatus::Adding);
        }
    }
    // Третий таймаут → dead, раздача считается проверенной, треки not_found / dead_torrents.
    verify_torrent(&ctx, tid, s.album_id).await.unwrap();
    let t = torrents::get(&pool, tid).await.unwrap().unwrap();
    assert_eq!(t.meta_status, MetaStatus::Dead);
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!(
            (st, reason.as_deref()),
            (TrackStatus::NotFound, Some("dead_torrents"))
        );
    }
    let not_found = drain(&mut rx)
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::TrackStatus {
                    status: TrackStatus::NotFound,
                    ..
                }
            )
        })
        .count();
    assert_eq!(not_found, 4);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrent_without_needed_files_gives_no_match(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let b = add_torrent(&pool, s.album_id, 2, 0.5).await;
    let other: Vec<(&'static str, u64)> = vec![
        ("Muse - Absolution/01 - Apocalypse Please.flac", 1 << 25),
        ("Muse - Absolution/02 - Time Is Running Out.flac", 1 << 25),
    ];
    let fetcher = FakeFetcher::new(vec![
        (hash(1), Reply::Files(other.clone())),
        (hash(2), Reply::Invalid),
    ]);
    let (ctx, _) = ctx(&pool, fetcher);

    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    // Одна раздача ещё не проверена — решения нет.
    for (st, _) in statuses(&pool, s.album_id).await {
        assert_eq!(st, TrackStatus::Adding);
    }
    verify_torrent(&ctx, b, s.album_id).await.unwrap();
    assert_eq!(
        torrents::get(&pool, b).await.unwrap().unwrap().meta_status,
        MetaStatus::Error
    );
    // Раздача `a` — `ok`, значит не все мертвы → no_match.
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!(
            (st, reason.as_deref()),
            (TrackStatus::NotFound, Some("no_match"))
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn second_torrent_adds_backup_sources_without_changing_primary(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let b = add_torrent(&pool, s.album_id, 2, 0.5).await;
    let mp3: Vec<(&'static str, u64)> = OK
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                leak(format!(
                    "Radiohead - OK Computer [MP3]/{:02} - {t}.mp3",
                    i + 1
                )),
                9_000_000,
            )
        })
        .collect();
    let fetcher = FakeFetcher::new(vec![
        (hash(1), Reply::Files(good_files())),
        (hash(2), Reply::Files(mp3)),
    ]);
    let (ctx, _) = ctx(&pool, fetcher);
    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    verify_torrent(&ctx, b, s.album_id).await.unwrap();

    for id in &s.track_ids {
        let srcs = track_sources::list_for_track(&pool, *id).await.unwrap();
        assert_eq!(srcs.len(), 2);
        assert_eq!(srcs.iter().filter(|s| s.is_primary).count(), 1);
        let primary = srcs.iter().find(|s| s.is_primary).unwrap();
        assert_eq!(primary.torrent_id, a, "primary остаётся от первой раздачи");
    }
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!((st, reason), (TrackStatus::Found, None));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn not_found_track_becomes_found_when_better_torrent_appears(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let fetcher = FakeFetcher::new(vec![(hash(1), Reply::Files(vec![("junk/readme.txt", 10)]))]);
    let (ctx, _) = ctx(&pool, fetcher.clone());
    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    assert_eq!(
        statuses(&pool, s.album_id).await[0].0,
        TrackStatus::NotFound
    );

    // Появилась вторая раздача (например, ретрай) — треки возвращаются в found.
    let b = add_torrent(&pool, s.album_id, 2, 0.8).await;
    fetcher
        .replies
        .lock()
        .unwrap()
        .insert(hash(2).to_string(), Reply::Files(good_files()));
    verify_torrent(&ctx, b, s.album_id).await.unwrap();
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!((st, reason), (TrackStatus::Found, None));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn confirmation_only_source_still_becomes_primary(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    // Файлы без названий: совпадение только с подтверждением.
    let nameless: Vec<(&'static str, u64)> = (1..=4)
        .map(|i| {
            (
                leak(format!("Radiohead - OK Computer/{i:02}.flac")),
                30_000_000,
            )
        })
        .collect();
    let (ctx, _) = ctx(
        &pool,
        FakeFetcher::new(vec![(hash(1), Reply::Files(nameless))]),
    );
    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    for id in &s.track_ids {
        let p = track_sources::primary_for_track(&pool, *id)
            .await
            .unwrap()
            .unwrap();
        assert!(p.needs_confirmation);
    }
    for (st, _) in statuses(&pool, s.album_id).await {
        assert_eq!(st, TrackStatus::Found);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cue_image_is_recorded_and_tracks_end_up_not_found(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let files = vec![
        (
            "Radiohead - OK Computer (1997)/OK Computer.flac",
            300_000_000,
        ),
        ("Radiohead - OK Computer (1997)/OK Computer.cue", 3_000),
    ];
    let (ctx, _) = ctx(
        &pool,
        FakeFetcher::new(vec![(hash(1), Reply::Files(files))]),
    );
    verify_torrent(&ctx, a, s.album_id).await.unwrap();

    let rows = cue_candidates::list_for_album(&pool, s.album_id)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0].torrent_id,
            rows[0].cue_file_index,
            rows[0].image_file_index
        ),
        (a, 1, 0)
    );
    assert!(!rows[0].processed);
    // Финализация альбома ждёт разбора CUE (шаг 21): треки пока `adding`, задача `process_cue` в очереди.
    for (st, _) in statuses(&pool, s.album_id).await {
        assert_eq!(st, TrackStatus::Adding);
    }
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert!(queued.iter().any(|j| j.kind == "process_cue"
        && j.payload
            == serde_json::json!({"torrent_id": a, "album_id": s.album_id, "cue_file_index": 1})));
    // Повтор не дублирует строку.
    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    assert_eq!(
        cue_candidates::list_for_album(&pool, s.album_id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn queued_discover_blocks_not_found_and_found_album_demotes_other_verifies(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let b = add_torrent(&pool, s.album_id, 2, 0.5).await;
    // Ждёт поиска: решения «not_found» принимать рано.
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum {
            album_id: s.album_id,
        },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: b,
            album_id: s.album_id,
        },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let fetcher = FakeFetcher::new(vec![
        (hash(1), Reply::Files(vec![("x/readme.txt", 1)])),
        (hash(2), Reply::Files(vec![("x/readme.txt", 1)])),
    ]);
    let (ctx, _) = ctx(&pool, fetcher);
    verify_torrent(&ctx, a, s.album_id).await.unwrap();
    verify_torrent(&ctx, b, s.album_id).await.unwrap();
    for (st, _) in statuses(&pool, s.album_id).await {
        assert_eq!(st, TrackStatus::Adding, "discover_album ещё в очереди");
    }
    sqlx::query("UPDATE jobs SET state = 'done' WHERE kind = 'discover_album'")
        .execute(&pool)
        .await
        .unwrap();

    // Второй альбом: после успеха первой раздачи вторая понижается до фонового приоритета.
    let s2 = setup(&pool, &OK).await;
    let c = add_torrent(&pool, s2.album_id, 3, 0.9).await;
    let d = add_torrent(&pool, s2.album_id, 4, 0.5).await;
    jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: d,
            album_id: s2.album_id,
        },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let fetcher = FakeFetcher::new(vec![(hash(3), Reply::Files(good_files()))]);
    let (ctx2, _) = self::ctx(&pool, fetcher);
    verify_torrent(&ctx2, c, s2.album_id).await.unwrap();
    let row = jobs::list(&pool, Some("queued"), 10)
        .await
        .unwrap()
        .into_iter()
        .find(|j| j.kind == "verify_torrent" && j.payload["album_id"] == s2.album_id)
        .unwrap();
    assert_eq!(row.priority, nimbus_core::jobs::PRIORITY_BACKGROUND);
    assert!(
        row.run_after <= chrono::Utc::now(),
        "запуск не откладывается, только понижается приоритет"
    );
    // Статусы не ждут резервных раздач.
    for (st, _) in statuses(&pool, s2.album_id).await {
        assert_eq!(st, TrackStatus::Found);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn concurrent_verifies_finalize_exactly_once(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let mut ids = vec![];
    let mut replies = vec![];
    for n in 1..=6u8 {
        ids.push(add_torrent(&pool, s.album_id, n, 0.5).await);
        replies.push((hash(n), Reply::Files(vec![("x/readme.txt", 1)])));
    }
    let (ctx, events) = ctx(&pool, FakeFetcher::new(replies));
    let mut rx = events.subscribe();
    let mut set = tokio::task::JoinSet::new();
    for id in ids {
        let c = ctx.clone();
        let album = s.album_id;
        set.spawn(async move { verify_torrent(&c, id, album).await });
    }
    while let Some(r) = set.join_next().await {
        r.unwrap().unwrap();
    }
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!(
            (st, reason.as_deref()),
            (TrackStatus::NotFound, Some("no_match"))
        );
    }
    let nf = drain(&mut rx)
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::TrackStatus {
                    status: TrackStatus::NotFound,
                    ..
                }
            )
        })
        .count();
    assert_eq!(nf, 4, "каждый трек переведён в not_found ровно один раз");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn handler_dispatch_and_missing_entities(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let a = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let (ctx, _) = ctx(
        &pool,
        FakeFetcher::new(vec![(hash(1), Reply::Files(good_files()))]),
    );
    VerifyHandler
        .handle(
            Job::VerifyTorrent {
                torrent_id: a,
                album_id: s.album_id,
            },
            &ctx,
        )
        .await
        .unwrap();
    assert!(matches!(
        verify_torrent(&ctx, 9999, s.album_id).await,
        Err(JobError::Fatal(_))
    ));
    assert!(matches!(
        verify_torrent(&ctx, a, 9999).await,
        Err(JobError::Fatal(_))
    ));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_verify_marks_torrent_verified_and_tracks_not_found(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let t = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let (ctx, _) = ctx(&pool, FakeFetcher::new(vec![]));
    // Раздача так и не дала метаданные (verify падал `Unexpected` до исчерпания попыток).
    VerifyHandler
        .on_exhausted(
            &Job::VerifyTorrent {
                torrent_id: t,
                album_id: s.album_id,
            },
            &ctx,
            "db down",
        )
        .await
        .unwrap();
    assert_eq!(
        album_torrents::count_unverified(&pool, s.album_id)
            .await
            .unwrap(),
        0
    );
    let torrent = torrents::get(&pool, t).await.unwrap().unwrap();
    assert_eq!(torrent.meta_status, MetaStatus::Error);
    for (st, reason) in statuses(&pool, s.album_id).await {
        assert_eq!(st, TrackStatus::NotFound, "а не вечный adding");
        assert_eq!(reason.as_deref(), Some("dead_torrents"));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_verify_keeps_successful_metadata_status(pool: PgPool) {
    let s = setup(&pool, &OK).await;
    let t = add_torrent(&pool, s.album_id, 1, 0.9).await;
    torrents::set_meta_status(&pool, t, MetaStatus::Ok, None)
        .await
        .unwrap();
    let (ctx, _) = ctx(&pool, FakeFetcher::new(vec![]));
    VerifyHandler
        .on_exhausted(
            &Job::VerifyTorrent {
                torrent_id: t,
                album_id: s.album_id,
            },
            &ctx,
            "boom",
        )
        .await
        .unwrap();
    let torrent = torrents::get(&pool, t).await.unwrap().unwrap();
    assert_eq!(torrent.meta_status, MetaStatus::Ok);
    assert_eq!(
        album_torrents::count_unverified(&pool, s.album_id)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn verify_job_that_times_out_to_exhaustion_leaves_no_adding_tracks(pool: PgPool) {
    // Сквозной сценарий через раннер: единственная попытка, таймаут метаданных → failed → хук.
    let s = setup(&pool, &OK).await;
    let t = add_torrent(&pool, s.album_id, 1, 0.9).await;
    let (ctx, _) = ctx(&pool, FakeFetcher::new(vec![(hash(1), Reply::Timeout)]));
    let id = jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: t,
            album_id: s.album_id,
        },
        EnqueueOpts {
            max_attempts: Some(1),
            ..EnqueueOpts::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    let w = nimbus_worker::WorkerPool::spawn(
        ctx,
        vec![(Arc::new(VerifyHandler) as Arc<dyn JobHandler>, 1)],
        nimbus_worker::WorkerConfig {
            poll_interval: std::time::Duration::from_millis(50),
            maintenance_interval: std::time::Duration::from_secs(3600),
            ..nimbus_worker::WorkerConfig::default()
        },
    );
    nimbus_testkit::eventually(std::time::Duration::from_secs(10), || async {
        let job_failed = jobs::list(&pool, Some("failed"), 10)
            .await
            .unwrap()
            .iter()
            .any(|j| j.id == id);
        job_failed
            && statuses(&pool, s.album_id)
                .await
                .iter()
                .all(|(st, _)| *st == TrackStatus::NotFound)
    })
    .await;
    w.shutdown().await;
}
