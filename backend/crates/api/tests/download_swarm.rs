// Сквозной тест шага 33: закреплённый «альбом» из 3 файлов качается из локального роя настоящим
// движком. unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
#![cfg(feature = "test-fakes")]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{get_json, request_json, router, state};
use nimbus_api::download_manager::{DownloadManager, ManagerConfig};
use nimbus_api::stream::Watcher;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, downloads, pins, torrents, track_sources, tracks};
use nimbus_torrent::fake_swarm;
use nimbus_torrent::{EngineConfig, TorrentEngine};
use rand::RngCore;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pinned_album_is_downloaded_from_a_local_swarm(pool: PgPool) {
    let root = std::env::temp_dir().join(format!("nimbus-dm-swarm-{}", Uuid::new_v4()));
    let contents: Vec<Vec<u8>> = (0..3)
        .map(|i| {
            let mut v = vec![0u8; 150_000 + i * 10_000];
            rand::rng().fill_bytes(&mut v);
            v
        })
        .collect();
    let files: Vec<(String, Vec<u8>)> = contents
        .iter()
        .enumerate()
        .map(|(i, c)| (format!("{:02} - Song.flac", i + 1), c.clone()))
        .collect();
    let swarm = fake_swarm::start(&root.join("swarm"), "Album", &files)
        .await
        .unwrap();
    let mut cfg = EngineConfig::new(root.join("engine"), true);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.initial_peers = vec![swarm.addr];
    let engine = Arc::new(TorrentEngine::new(cfg).await.unwrap());
    let st = state(pool.clone()).with_engine(engine.clone());
    let app = router(st.clone());

    // Альбом из трёх треков, у каждого primary — свой файл раздачи.
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
            title: "Album".into(),
            primary_type: None,
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let torrent = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&swarm.info_hash).unwrap(),
            magnet: swarm.magnet.clone(),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "Album".into(),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    // Порядок файлов задаёт метаданные раздачи (обход каталога), а не порядок в `files`.
    let meta = engine.fetch_metadata(&swarm.magnet).await.unwrap();
    let mut by_index: Vec<Vec<u8>> = vec![vec![]; meta.files.len()];
    let rows: Vec<NewTorrentFile> = meta
        .files
        .iter()
        .map(|f| {
            by_index[f.index] = files.iter().find(|(n, _)| *n == f.path).unwrap().1.clone();
            NewTorrentFile {
                file_index: f.index as i32,
                path: format!("Album/{}", f.path),
                size_bytes: f.size as i64,
                ext: Some("flac".into()),
            }
        })
        .collect();
    torrents::replace_files(&pool, torrent.id, &rows)
        .await
        .unwrap();
    let mut track_ids = vec![];
    for i in 0..3 {
        let t = tracks::upsert_by_mbid_track(
            &pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: album.id,
                artist_id: artist.id,
                title: format!("Song {i}"),
                disc_no: 1,
                position: i + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        tracks::set_status(&pool, t.id, TrackStatus::Found, None)
            .await
            .unwrap();
        let src = track_sources::insert(
            &pool,
            &NewTrackSource {
                track_id: t.id,
                torrent_id: torrent.id,
                file_index: i,
                match_score: 1.0,
                needs_confirmation: false,
                cue_start_ms: None,
                cue_end_ms: None,
            },
        )
        .await
        .unwrap();
        track_sources::set_primary(&pool, t.id, src.id)
            .await
            .unwrap();
        track_ids.push(t.id);
    }
    albums::set_in_library(&pool, album.id, true).await.unwrap();
    tracks::set_in_library_for_album(&pool, album.id, true)
        .await
        .unwrap();

    let (code, v) = request_json(
        app.clone(),
        "POST",
        &format!("/api/albums/{}/download", album.id),
        None,
    )
    .await;
    assert_eq!((code, &v["pinned"]), (200, &serde_json::json!(3)));

    let mut manager = DownloadManager::new(
        st.clone(),
        ManagerConfig {
            tick: Duration::from_millis(50),
            ..ManagerConfig::default()
        },
    );
    manager.tick().await.unwrap();
    let driver = tokio::sync::Mutex::new((manager, Watcher::new()));
    let (_, v) = get_json(app.clone(), "/api/downloads").await;
    assert_eq!(v["paused"], false);
    assert_eq!(v["queue"]["downloading"], 3);

    nimbus_testkit::eventually(Duration::from_secs(30), || async {
        let (manager, watcher) = &mut *driver.lock().await;
        watcher.tick(&st).await.unwrap();
        manager.tick().await.unwrap();
        let mut all = true;
        for &id in &track_ids {
            all &= pins::get(&pool, id).await.unwrap().unwrap().state == PinState::Done;
        }
        all
    })
    .await;

    for (i, &id) in track_ids.iter().enumerate() {
        assert_eq!(
            tracks::get(&pool, id).await.unwrap().unwrap().status,
            TrackStatus::Ready
        );
        let d = downloads::get(&pool, torrent.id, i as i32)
            .await
            .unwrap()
            .unwrap();
        assert!(d.completed_at.is_some());
        let got = std::fs::read(&d.local_path).unwrap();
        assert!(
            got == by_index[i],
            "file {i}: {} bytes on disk, {} expected, matches source {:?}, path {}",
            got.len(),
            by_index[i].len(),
            by_index.iter().position(|c| *c == got),
            d.local_path
        );
    }
    let (_, v) = get_json(app, "/api/downloads").await;
    assert_eq!(v["queue"]["downloading"], 0);
    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
