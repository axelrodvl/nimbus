use std::time::Duration;

use nimbus_core::model::*;
use nimbus_db::repo::*;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn seed_album(pool: &PgPool) -> (Artist, Album) {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Artist".into(),
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
            title: "Album".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec!["Live".into()],
            year: Some(2001),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    (artist, album)
}

fn new_track(artist: &Artist, album: &Album, pos: i32, mbid_track: Uuid) -> NewTrack {
    NewTrack {
        mbid_recording: Uuid::new_v4(),
        mbid_track: Some(mbid_track),
        album_id: album.id,
        artist_id: artist.id,
        title: format!("Track {pos}"),
        disc_no: 1,
        position: pos,
        duration_ms: Some(180_000),
    }
}

fn new_torrent(hash: &str) -> NewTorrent {
    NewTorrent {
        info_hash: InfoHash::parse(hash).unwrap(),
        magnet: format!("magnet:?xt=urn:btih:{hash}"),
        source: TorrentSource::Tpb,
        source_topic_id: None,
        title: "Artist - Album FLAC".into(),
        size_bytes: Some(1000),
        seeders: Some(5),
        leechers: Some(1),
        kind: TorrentKind::Album,
    }
}

const H1: &str = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
const H2: &str = "0123456789abcdef0123456789abcdef01234567";

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_and_album_upsert_idempotent(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let again = artists::upsert_by_mbid(
        &pool,
        &NewArtist {
            mbid: artist.mbid,
            name: "Renamed".into(),
            sort_name: Some("Renamed".into()),
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(again.id, artist.id);
    assert_eq!(again.name, "Renamed");
    assert_eq!(
        artists::get_by_mbid(&pool, artist.mbid)
            .await
            .unwrap()
            .unwrap()
            .id,
        artist.id
    );

    let a2 = albums::upsert_by_rg_mbid(
        &pool,
        &NewAlbum {
            mbid_release_group: album.mbid_release_group,
            mbid_release: Some(Uuid::new_v4()),
            artist_id: artist.id,
            title: "Album v2".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(2002),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(a2.id, album.id);
    assert_eq!(a2.title, "Album v2");
    assert!(a2.mbid_release.is_some());
    assert_eq!(
        albums::list_by_artist(&pool, artist.id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn library_flags_and_pagination(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    assert!(artists::list_in_library(&pool, None, 10)
        .await
        .unwrap()
        .is_empty());
    let a = artists::set_in_library(&pool, artist.id, true)
        .await
        .unwrap()
        .unwrap();
    assert!(a.in_library && a.added_at.is_some());
    assert_eq!(
        artists::list_in_library(&pool, None, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    albums::set_in_library(&pool, album.id, true).await.unwrap();
    assert_eq!(
        albums::list_in_library(&pool, None, 10)
            .await
            .unwrap()
            .len(),
        1
    );

    let mut ids = vec![];
    for i in 1..=3 {
        let t = tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, i, Uuid::new_v4()))
            .await
            .unwrap();
        tracks::set_in_library(&pool, t.id, true).await.unwrap();
        ids.push(t.id);
    }
    let f = TrackFilter::default();
    let page1 = tracks::list_in_library(&pool, &f, None, 2).await.unwrap();
    assert_eq!(
        page1.iter().map(|t| t.id).collect::<Vec<_>>(),
        vec![ids[2], ids[1]]
    );
    let page2 = tracks::list_in_library(&pool, &f, Some(page1[1].id), 2)
        .await
        .unwrap();
    assert_eq!(page2.iter().map(|t| t.id).collect::<Vec<_>>(), vec![ids[0]]);

    tracks::set_status(&pool, ids[0], TrackStatus::Found, None)
        .await
        .unwrap();
    let found = tracks::list_in_library(
        &pool,
        &TrackFilter {
            status: Some(TrackStatus::Found),
        },
        None,
        10,
    )
    .await
    .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, ids[0]);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_upsert_keeps_status(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let mbid_track = Uuid::new_v4();
    let t = tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, 1, mbid_track))
        .await
        .unwrap();
    assert_eq!(t.status, TrackStatus::Adding);
    let t = tracks::set_status(
        &pool,
        t.id,
        TrackStatus::NotFound,
        Some(NotFoundReason::NoTorrents),
    )
    .await
    .unwrap();
    assert_eq!(t.status_reason.as_deref(), Some("no_torrents"));

    let mut changed = new_track(&artist, &album, 1, mbid_track);
    changed.title = "Renamed".into();
    let again = tracks::upsert_by_mbid_track(&pool, &changed).await.unwrap();
    assert_eq!(again.id, t.id);
    assert_eq!(again.title, "Renamed");
    assert_eq!(again.status, TrackStatus::NotFound);
    assert_eq!(again.status_reason.as_deref(), Some("no_torrents"));
    assert!(again.updated_at >= t.updated_at);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn set_status_for_album_only_from_given(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let mut ts = vec![];
    for i in 1..=3 {
        ts.push(
            tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, i, Uuid::new_v4()))
                .await
                .unwrap(),
        );
    }
    tracks::set_status(&pool, ts[0].id, TrackStatus::Ready, None)
        .await
        .unwrap();
    let changed = tracks::set_status_for_album(
        &pool,
        album.id,
        &[TrackStatus::Adding],
        TrackStatus::NotFound,
        Some(NotFoundReason::NoMatch),
    )
    .await
    .unwrap();
    assert_eq!(changed.len(), 2);
    let all = tracks::list_by_album(&pool, album.id).await.unwrap();
    assert_eq!(all[0].status, TrackStatus::Ready);
    assert_eq!(all[1].status, TrackStatus::NotFound);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrents_files_and_links(pool: PgPool) {
    let (_, album) = seed_album(&pool).await;
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    assert_eq!(t.info_hash, H1);
    assert_eq!(t.meta_status, MetaStatus::Pending);

    let t = torrents::set_meta_status(&pool, t.id, MetaStatus::Fetching, None)
        .await
        .unwrap();
    assert_eq!(t.meta_attempts, 1);
    let mut upd = new_torrent(H1);
    upd.seeders = Some(50);
    upd.title = "New title".into();
    let t2 = torrents::upsert_by_info_hash(&pool, &upd).await.unwrap();
    assert_eq!(t2.id, t.id);
    assert_eq!((t2.seeders, t2.title.as_str()), (Some(50), "New title"));
    assert_eq!(
        t2.meta_status,
        MetaStatus::Fetching,
        "meta_* не сбрасывается"
    );
    let t = torrents::set_meta_status(&pool, t.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    assert!(t.fetched_at.is_some());

    let f = |i, p: &str| NewTorrentFile {
        file_index: i,
        path: p.into(),
        size_bytes: 10,
        ext: p.rsplit_once('.').map(|(_, e)| e.to_string()),
    };
    torrents::replace_files(
        &pool,
        t.id,
        &[f(0, "a/01.flac"), f(1, "a/02.flac"), f(2, "a/cover.jpg")],
    )
    .await
    .unwrap();
    assert_eq!(torrents::files(&pool, t.id).await.unwrap().len(), 3);
    torrents::replace_files(&pool, t.id, &[f(0, "b/x.mp3")])
        .await
        .unwrap();
    let files = torrents::files(&pool, t.id).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "b/x.mp3");
    assert_eq!(files[0].ext.as_deref(), Some("mp3"));

    // album_torrents
    let t_b = torrents::upsert_by_info_hash(&pool, &new_torrent(H2))
        .await
        .unwrap();
    album_torrents::link(&pool, album.id, t.id, "q1", 0.4)
        .await
        .unwrap();
    let l = album_torrents::link(&pool, album.id, t.id, "q2", 0.2)
        .await
        .unwrap();
    assert_eq!(l.rank_score, 0.4, "берётся максимум");
    album_torrents::link(&pool, album.id, t_b.id, "q1", 0.9)
        .await
        .unwrap();
    let list = album_torrents::list_for_album(&pool, album.id)
        .await
        .unwrap();
    assert_eq!(
        list.iter().map(|r| r.torrent.id).collect::<Vec<_>>(),
        vec![t_b.id, t.id]
    );
    assert_eq!(
        album_torrents::count_unverified(&pool, album.id)
            .await
            .unwrap(),
        2
    );
    album_torrents::mark_verified(&pool, album.id, t.id)
        .await
        .unwrap();
    assert_eq!(
        album_torrents::count_unverified(&pool, album.id)
            .await
            .unwrap(),
        1
    );
    assert!(
        album_torrents::list_for_album(&pool, album.id)
            .await
            .unwrap()[1]
            .verified
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn set_primary_keeps_exactly_one(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let track = tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, 1, Uuid::new_v4()))
        .await
        .unwrap();
    let other = tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, 2, Uuid::new_v4()))
        .await
        .unwrap();
    let tor = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    let mk = |track_id, file_index, score| NewTrackSource {
        track_id,
        torrent_id: tor.id,
        file_index,
        match_score: score,
        needs_confirmation: false,
        cue_start_ms: None,
        cue_end_ms: None,
    };
    let s1 = track_sources::insert(&pool, &mk(track.id, 0, 0.5))
        .await
        .unwrap();
    let s2 = track_sources::insert(&pool, &mk(track.id, 1, 0.9))
        .await
        .unwrap();
    let foreign = track_sources::insert(&pool, &mk(other.id, 2, 0.7))
        .await
        .unwrap();
    // идемпотентность
    assert_eq!(
        track_sources::insert(&pool, &mk(track.id, 0, 0.6))
            .await
            .unwrap()
            .id,
        s1.id
    );

    assert!(track_sources::primary_for_track(&pool, track.id)
        .await
        .unwrap()
        .is_none());
    track_sources::set_primary(&pool, track.id, s1.id)
        .await
        .unwrap();
    track_sources::set_primary(&pool, track.id, s2.id)
        .await
        .unwrap();
    let list = track_sources::list_for_track(&pool, track.id)
        .await
        .unwrap();
    assert_eq!(list.iter().filter(|s| s.is_primary).count(), 1);
    assert_eq!(list[0].id, s2.id);
    assert_eq!(
        track_sources::primary_for_track(&pool, track.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        s2.id
    );

    // чужой источник: ошибка и откат (primary не потерян)
    assert!(matches!(
        track_sources::set_primary(&pool, track.id, foreign.id).await,
        Err(sqlx::Error::RowNotFound)
    ));
    assert_eq!(
        track_sources::primary_for_track(&pool, track.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        s2.id
    );

    // прямая попытка второго primary нарушает уникальный индекс
    assert!(
        sqlx::query("UPDATE track_sources SET is_primary = TRUE WHERE id = $1")
            .bind(s1.id)
            .execute(&pool)
            .await
            .is_err()
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn downloads_lifecycle(pool: PgPool) {
    let tor = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    let d = downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: tor.id,
            file_index: 3,
            local_path: "/data/x.flac".into(),
            bytes_total: 100,
            bytes_done: 10,
        },
    )
    .await
    .unwrap();
    assert!(d.completed_at.is_none());
    let d = downloads::mark_completed(&pool, tor.id, 3)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.bytes_done, 100);
    assert!(d.completed_at.is_some());
    assert!(downloads::get(&pool, tor.id, 3)
        .await
        .unwrap()
        .unwrap()
        .last_played_at
        .is_none());
    downloads::touch_played(&pool, tor.id, 3).await.unwrap();
    assert!(downloads::get(&pool, tor.id, 3)
        .await
        .unwrap()
        .unwrap()
        .last_played_at
        .is_some());
    assert!(downloads::get(&pool, tor.id, 4).await.unwrap().is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn mb_cache_ttl(pool: PgPool) {
    mb_cache::put(&pool, "k1", &json!({"a": 1}), Duration::from_secs(3600))
        .await
        .unwrap();
    mb_cache::put(&pool, "k2", &json!({"b": 2}), Duration::from_secs(3600))
        .await
        .unwrap();
    assert_eq!(
        mb_cache::get(&pool, "k1").await.unwrap(),
        Some(json!({"a": 1}))
    );
    // перезапись
    mb_cache::put(&pool, "k1", &json!({"a": 2}), Duration::from_secs(3600))
        .await
        .unwrap();
    assert_eq!(
        mb_cache::get(&pool, "k1").await.unwrap(),
        Some(json!({"a": 2}))
    );
    // истёкшая запись не отдаётся и удаляется
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '1 second' WHERE key = 'k2'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(mb_cache::get(&pool, "k2").await.unwrap().is_none());
    assert_eq!(mb_cache::purge_expired(&pool).await.unwrap(), 1);
    assert!(mb_cache::get(&pool, "k1").await.unwrap().is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn check_constraints_reject_bad_values(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let t = tracks::upsert_by_mbid_track(&pool, &new_track(&artist, &album, 1, Uuid::new_v4()))
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE tracks SET status = 'bogus' WHERE id = $1")
            .bind(t.id)
            .execute(&pool)
            .await
            .is_err()
    );
    for bad in ["XYZ", "C12FE1C06BBA254A9DC9F519B335AA7C1367A88A", "abc"] {
        assert!(
            sqlx::query("INSERT INTO torrents (info_hash, magnet, source, title) VALUES ($1, 'm', 'tpb', 't')")
                .bind(bad)
                .execute(&pool)
                .await
                .is_err(),
            "{bad} должен быть отвергнут"
        );
    }
    assert!(sqlx::query(
        "INSERT INTO torrents (info_hash, magnet, source, title, kind) VALUES ($1, 'm', 'tpb', 't', 'weird')"
    )
    .bind(H2)
    .execute(&pool)
    .await
    .is_err());
    assert!(sqlx::query(
        "INSERT INTO torrents (info_hash, magnet, source, title, meta_status) VALUES ($1, 'm', 'tpb', 't', 'weird')"
    )
    .bind(H2)
    .execute(&pool)
    .await
    .is_err());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn jobs_dedup_index(pool: PgPool) {
    let ins = "INSERT INTO jobs (kind, payload, dedup_key) VALUES ('x', '{}', 'k')";
    sqlx::query(ins).execute(&pool).await.unwrap();
    assert!(
        sqlx::query(ins).execute(&pool).await.is_err(),
        "дубликат активной задачи"
    );
    sqlx::query("UPDATE jobs SET state = 'done'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(ins).execute(&pool).await.unwrap();
}
