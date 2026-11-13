// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::path::PathBuf;
use std::sync::Arc;

use nimbus_core::activity::Activity;
use nimbus_core::events::EventBus;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, downloads, torrents, track_sources, tracks};
use nimbus_worker::cache::{evict_cache, usage};
use nimbus_worker::JobCtx;
use sqlx::PgPool;
use uuid::Uuid;

struct Item {
    torrent_id: i64,
    track_id: i64,
    path: PathBuf,
}

fn ctx(pool: &PgPool, activity: Activity) -> JobCtx {
    JobCtx::new(
        pool.clone(),
        EventBus::new(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
    .with_activity(activity)
}

/// Скачанный файл `size` байт для трека; `age_days` — как давно его играли.
async fn item(pool: &PgPool, root: &std::path::Path, n: u8, size: usize, age_days: i64) -> Item {
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
    let album = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
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
    let track = tracks::upsert_by_mbid_track(
        pool,
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
    tracks::set_status(pool, track.id, TrackStatus::Ready, None)
        .await
        .unwrap();
    let hash = format!("{n:02x}").repeat(20);
    let t = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&hash).unwrap(),
            magnet: format!("magnet:?xt=urn:btih:{hash}"),
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
            path: "f.flac".into(),
            size_bytes: size as i64,
            ext: Some("flac".into()),
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
            match_score: 1.0,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    track_sources::set_primary(pool, track.id, src.id)
        .await
        .unwrap();

    let dir = root.join("torrents").join(format!("t{n}"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("f.flac");
    std::fs::write(&path, vec![7u8; size]).unwrap();
    downloads::upsert(
        pool,
        &NewDownload {
            torrent_id: t.id,
            file_index: 0,
            local_path: path.to_string_lossy().into_owned(),
            bytes_total: size as i64,
            bytes_done: size as i64,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(pool, t.id, 0).await.unwrap();
    sqlx::query(
        "UPDATE downloads SET last_played_at = now() - make_interval(days => $3::int)
         WHERE torrent_id = $1 AND file_index = $2",
    )
    .bind(t.id)
    .bind(0i32)
    .bind(age_days as i32)
    .execute(pool)
    .await
    .unwrap();
    Item {
        torrent_id: t.id,
        track_id: track.id,
        path,
    }
}

fn root() -> PathBuf {
    std::env::temp_dir().join(format!("nimbus-evict-{}", Uuid::new_v4()))
}

async fn status(pool: &PgPool, id: i64) -> TrackStatus {
    tracks::get(pool, id).await.unwrap().unwrap().status
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn evicts_oldest_first_until_ninety_percent(pool: PgPool) {
    let root = root();
    // Возраст: a — 10 дней, b — 5, c — 2, d — 1 (по 1000 байт). Лимит 3500: 4000 > 3500, цель 3150.
    let a = item(&pool, &root, 1, 1000, 10).await;
    let b = item(&pool, &root, 2, 1000, 5).await;
    let c = item(&pool, &root, 3, 1000, 2).await;
    let d = item(&pool, &root, 4, 1000, 1).await;
    let ctx = ctx(&pool, Activity::default());
    assert_eq!(usage(&pool).await.unwrap().used_bytes, 4000);

    let r = evict_cache(&ctx, 3500).await.unwrap();
    assert_eq!((r.used_before, r.used_after), (4000, 3000));
    assert_eq!(r.evicted, vec![(a.torrent_id, 0)]);
    assert!(!a.path.exists() && b.path.exists() && c.path.exists() && d.path.exists());
    assert!(!a.path.parent().unwrap().exists(), "empty dir is pruned");
    assert!(root.join("torrents").exists(), "torrents root stays");
    assert!(downloads::get(&pool, a.torrent_id, 0)
        .await
        .unwrap()
        .is_none());
    assert_eq!(status(&pool, a.track_id).await, TrackStatus::Found);
    for t in [&b, &c, &d] {
        assert_eq!(status(&pool, t.track_id).await, TrackStatus::Ready);
    }

    // Сильно уменьшили лимит: уходят b и c, самый свежий остаётся пока цель не достигнута.
    let r = evict_cache(&ctx, 1200).await.unwrap();
    assert_eq!(r.evicted, vec![(b.torrent_id, 0), (c.torrent_id, 0)]);
    assert!(d.path.exists());
    assert_eq!(usage(&pool).await.unwrap().used_bytes, 1000);
    let _ = std::fs::remove_dir_all(&root);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn does_nothing_under_the_limit(pool: PgPool) {
    let root = root();
    let a = item(&pool, &root, 1, 1000, 10).await;
    let r = evict_cache(&ctx(&pool, Activity::default()), 1000)
        .await
        .unwrap();
    assert!(r.evicted.is_empty());
    assert!(a.path.exists());
    assert_eq!(status(&pool, a.track_id).await, TrackStatus::Ready);
    let _ = std::fs::remove_dir_all(&root);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn active_streams_and_fresh_prefetch_are_protected(pool: PgPool) {
    let root = root();
    let a = item(&pool, &root, 1, 1000, 10).await; // самый старый, но стримится
    let b = item(&pool, &root, 2, 1000, 9).await; // предзагружен недавно
    let c = item(&pool, &root, 3, 1000, 8).await;
    let d = item(&pool, &root, 4, 1000, 1).await;
    let activity = Activity::default();
    let guard = activity.begin_stream(a.torrent_id, 0);
    activity.mark_prefetched(b.torrent_id, 0);
    let ctx = ctx(&pool, activity.clone());

    let r = evict_cache(&ctx, 2500).await.unwrap();
    // Цель 2250: убираем c (старейший незащищённый), затем d — иначе не дойти до цели.
    assert_eq!(r.evicted, vec![(c.torrent_id, 0), (d.torrent_id, 0)]);
    assert!(a.path.exists() && b.path.exists());
    assert_eq!(status(&pool, a.track_id).await, TrackStatus::Ready);
    assert_eq!(status(&pool, b.track_id).await, TrackStatus::Ready);

    // Стрим закончился — файл снова доступен для вытеснения.
    drop(guard);
    let r = evict_cache(&ctx, 1500).await.unwrap();
    assert_eq!(r.evicted, vec![(a.torrent_id, 0)]);
    assert!(b.path.exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn missing_file_is_cleaned_up_without_error(pool: PgPool) {
    let root = root();
    let a = item(&pool, &root, 1, 1000, 10).await;
    let b = item(&pool, &root, 2, 1000, 1).await;
    std::fs::remove_file(&a.path).unwrap();
    // Файла нет → занимает 0 байт; лимит превышен только за счёт b.
    let r = evict_cache(&ctx(&pool, Activity::default()), 500)
        .await
        .unwrap();
    assert_eq!(r.evicted, vec![(b.torrent_id, 0)]);
    assert_eq!(status(&pool, b.track_id).await, TrackStatus::Found);
    let _ = std::fs::remove_dir_all(&root);
}
