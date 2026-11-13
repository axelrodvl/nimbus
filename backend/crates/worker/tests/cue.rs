// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nimbus_core::events::EventBus;
use nimbus_core::jobs::Job;
use nimbus_core::model::*;
use nimbus_db::repo::{
    album_torrents, albums, artists, cue_candidates, torrents, track_sources, tracks,
};
use nimbus_torrent::{AsyncReadSeek, EngineError, FileProgress, FileProvider, TorrentHandleId};
use nimbus_worker::cue::ProcessCueHandler;
use nimbus_worker::{JobCtx, JobError, JobHandler};
use sqlx::PgPool;
use uuid::Uuid;

/// «Движок»: CUE-файл уже лежит на диске.
struct Fake {
    path: PathBuf,
}

#[async_trait]
impl FileProvider for Fake {
    async fn ensure_file(&self, magnet: &str, _: usize) -> Result<TorrentHandleId, EngineError> {
        Ok(TorrentHandleId(InfoHash::from_magnet(magnet).unwrap()))
    }
    async fn open_stream(
        &self,
        _: &TorrentHandleId,
        _: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        Err(EngineError::NotFound)
    }
    fn file_progress(&self, _: &TorrentHandleId, _: usize) -> Option<FileProgress> {
        Some(FileProgress {
            bytes_done: 1,
            bytes_total: 1,
            peers: 0,
            down_speed_bps: 0,
            finished: true,
        })
    }
    fn file_path(&self, _: &TorrentHandleId, _: usize) -> Option<PathBuf> {
        Some(self.path.clone())
    }
}

const CUE: &str = "PERFORMER \"Кино\"\r\nTITLE \"Группа крови\"\r\nFILE \"Gruppa krovi.flac\" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE \"Группа крови\"\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    TITLE \"Закрой за мной дверь\"\r\n    INDEX 01 04:48:00\r\n  TRACK 03 AUDIO\r\n    TITLE \"Звезда по имени Солнце\"\r\n    INDEX 01 09:30:37\r\n";

struct World {
    album_id: i64,
    track_ids: Vec<i64>,
    torrent_id: i64,
}

async fn world(pool: &PgPool) -> World {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Кино".into(),
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
            title: "Группа крови".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(1988),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let mut track_ids = vec![];
    for (i, t) in [
        "Группа крови",
        "Закрой за мной дверь",
        "Звезда по имени Солнце",
    ]
    .iter()
    .enumerate()
    {
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
        tracks::set_in_library(pool, tr.id, true).await.unwrap();
        track_ids.push(tr.id);
    }
    let torrent = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&"ab".repeat(20)).unwrap(),
            magnet: format!("magnet:?xt=urn:btih:{}", "ab".repeat(20)),
            source: TorrentSource::Rutracker,
            source_topic_id: None,
            title: "Кино - Группа крови [FLAC image+cue]".into(),
            size_bytes: None,
            seeders: Some(5),
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    torrents::set_meta_status(pool, torrent.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    torrents::replace_files(
        pool,
        torrent.id,
        &[
            NewTorrentFile {
                file_index: 0,
                path: "Кино - Группа крови/Gruppa krovi.flac".into(),
                size_bytes: 300_000_000,
                ext: Some("flac".into()),
            },
            NewTorrentFile {
                file_index: 1,
                path: "Кино - Группа крови/Gruppa krovi.cue".into(),
                size_bytes: 600,
                ext: Some("cue".into()),
            },
        ],
    )
    .await
    .unwrap();
    album_torrents::link(pool, album.id, torrent.id, "q", 0.9)
        .await
        .unwrap();
    album_torrents::mark_verified(pool, album.id, torrent.id)
        .await
        .unwrap();
    cue_candidates::upsert(pool, torrent.id, album.id, 1, 0)
        .await
        .unwrap();
    World {
        album_id: album.id,
        track_ids,
        torrent_id: torrent.id,
    }
}

fn ctx(pool: &PgPool, cue_bytes: &[u8]) -> JobCtx {
    let path = std::env::temp_dir().join(format!("nimbus-cue-{}.cue", Uuid::new_v4()));
    std::fs::write(&path, cue_bytes).unwrap();
    JobCtx::new(
        pool.clone(),
        EventBus::new(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
    .with_files(Arc::new(Fake { path }))
}

fn job(w: &World) -> Job {
    Job::ProcessCue {
        torrent_id: w.torrent_id,
        album_id: w.album_id,
        cue_file_index: 1,
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cp1251_cue_links_tracks_to_image_segments(pool: PgPool) {
    let w = world(&pool).await;
    let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode(CUE);
    let ctx = ctx(&pool, &bytes);

    ProcessCueHandler.handle(job(&w), &ctx).await.unwrap();

    let expect = [
        (0, Some(288_000)),
        (288_000, Some(570_493)),
        (570_493, None),
    ];
    for (i, &tid) in w.track_ids.iter().enumerate() {
        let src = track_sources::primary_for_track(&pool, tid)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("track {i} has no primary"));
        assert_eq!(src.file_index, 0);
        assert_eq!(src.cue_start_ms, Some(expect[i].0), "start {i}");
        assert_eq!(src.cue_end_ms, expect[i].1, "end {i}");
        assert!(!src.needs_confirmation);
        assert_eq!(
            tracks::get(&pool, tid).await.unwrap().unwrap().status,
            TrackStatus::Found
        );
    }
    assert!(
        cue_candidates::list_for_album(&pool, w.album_id)
            .await
            .unwrap()[0]
            .processed
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn finalization_waits_for_cue_and_unmatched_tracks_become_not_found(pool: PgPool) {
    let w = world(&pool).await;
    // CUE описывает только два трека из трёх и не совпадает по числу: треки привязываются по названиям.
    let cue = CUE.replace(
        "  TRACK 03 AUDIO\r\n    TITLE \"Звезда по имени Солнце\"\r\n    INDEX 01 09:30:37\r\n",
        "",
    );
    let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode(&cue);
    let ctx = ctx(&pool, &bytes);

    assert_eq!(
        cue_candidates::count_pending(&pool, w.album_id)
            .await
            .unwrap(),
        1
    );
    ProcessCueHandler.handle(job(&w), &ctx).await.unwrap();
    assert_eq!(
        cue_candidates::count_pending(&pool, w.album_id)
            .await
            .unwrap(),
        0
    );

    let st = |id| {
        let pool = pool.clone();
        async move { tracks::get(&pool, id).await.unwrap().unwrap() }
    };
    assert_eq!(st(w.track_ids[0]).await.status, TrackStatus::Found);
    assert_eq!(st(w.track_ids[1]).await.status, TrackStatus::Found);
    let third = st(w.track_ids[2]).await;
    assert_eq!(third.status, TrackStatus::NotFound);
    assert_eq!(third.status_reason.as_deref(), Some("no_match"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unusable_cue_is_fatal_and_does_not_block_the_album(pool: PgPool) {
    let w = world(&pool).await;
    let ctx = ctx(&pool, b"this is not a cue sheet");
    let err = ProcessCueHandler.handle(job(&w), &ctx).await.unwrap_err();
    assert!(matches!(err, JobError::Fatal(_)));
    // Раннер при `Fatal` вызывает хук исчерпания: кандидат закрывается, альбом финализируется.
    assert_eq!(
        cue_candidates::count_pending(&pool, w.album_id)
            .await
            .unwrap(),
        1,
        "до хука кандидат ещё ждёт"
    );
    ProcessCueHandler
        .on_exhausted(&job(&w), &ctx, &err.to_string())
        .await
        .unwrap();
    assert_eq!(
        cue_candidates::count_pending(&pool, w.album_id)
            .await
            .unwrap(),
        0
    );
    for &tid in &w.track_ids {
        assert_eq!(
            tracks::get(&pool, tid).await.unwrap().unwrap().status,
            TrackStatus::NotFound
        );
    }
}
