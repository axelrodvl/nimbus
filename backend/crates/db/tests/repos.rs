// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
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
    // …но остаётся как запасной ответ, пока не прошёл срок хранения
    let stale = mb_cache::get_entry(&pool, "k2").await.unwrap().unwrap();
    assert_eq!(stale.value, json!({"b": 2}));
    assert!(stale.expired);
    let fresh = mb_cache::get_entry(&pool, "k1").await.unwrap().unwrap();
    assert!(!fresh.expired);
    assert!(mb_cache::get_entry(&pool, "nope").await.unwrap().is_none());
    assert_eq!(
        mb_cache::purge_expired(&pool, mb_cache::STALE_GRACE)
            .await
            .unwrap(),
        0,
        "свежепросроченное не удаляется"
    );
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '31 days' WHERE key = 'k2'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        mb_cache::purge_expired(&pool, mb_cache::STALE_GRACE)
            .await
            .unwrap(),
        1
    );
    assert!(mb_cache::get_entry(&pool, "k2").await.unwrap().is_none());
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

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrent_file_is_stored_separately_from_the_model(pool: PgPool) {
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    assert!(!t.has_torrent_file);
    assert_eq!(torrents::torrent_file(&pool, t.id).await.unwrap(), None);
    assert_eq!(torrents::torrent_file(&pool, 9999).await.unwrap(), None);

    assert!(
        torrents::set_torrent_file(&pool, t.id, b"d4:infod4:name1:aee")
            .await
            .unwrap()
    );
    // Флаг виден во всех запросах, возвращающих `Torrent`, а сам файл — только отдельным методом.
    assert!(
        torrents::get(&pool, t.id)
            .await
            .unwrap()
            .unwrap()
            .has_torrent_file
    );
    assert_eq!(
        torrents::torrent_file(&pool, t.id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"d4:infod4:name1:aee"[..])
    );
    // Повторный upsert (новая выдача провайдера) не стирает файл и отражает флаг.
    let again = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    assert!(again.has_torrent_file);
    let after_meta = torrents::set_meta_status(&pool, t.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    assert!(after_meta.has_torrent_file);
    assert_eq!(after_meta.meta_status, MetaStatus::Ok);

    // Перезапись допустима (свежие байты от движка).
    torrents::set_torrent_file(&pool, t.id, b"new")
        .await
        .unwrap();
    assert_eq!(
        torrents::torrent_file(&pool, t.id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"new"[..])
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn has_torrent_file_in_album_listings(pool: PgPool) {
    let (_, album) = seed_album(&pool).await;
    let with = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    let without = torrents::upsert_by_info_hash(&pool, &new_torrent(H2))
        .await
        .unwrap();
    torrents::set_torrent_file(&pool, with.id, b"x")
        .await
        .unwrap();
    for t in [&with, &without] {
        album_torrents::link(&pool, album.id, t.id, "q", 0.5)
            .await
            .unwrap();
    }
    let listed = album_torrents::list_for_album(&pool, album.id)
        .await
        .unwrap();
    let flag = |id| {
        listed
            .iter()
            .find(|r| r.torrent.id == id)
            .unwrap()
            .torrent
            .has_torrent_file
    };
    assert!(flag(with.id));
    assert!(!flag(without.id));
    let counted = album_torrents::list_with_counts(&pool, album.id)
        .await
        .unwrap();
    assert_eq!(
        counted
            .iter()
            .filter(|r| r.torrent.has_torrent_file)
            .count(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn oversized_torrent_file_is_not_stored(pool: PgPool) {
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    let big = vec![0u8; torrents::MAX_TORRENT_FILE_BYTES + 1];
    assert!(!torrents::set_torrent_file(&pool, t.id, &big).await.unwrap());
    assert!(!torrents::fill_torrent_file_by_hash(&pool, H1, &big)
        .await
        .unwrap());
    assert!(
        !torrents::get(&pool, t.id)
            .await
            .unwrap()
            .unwrap()
            .has_torrent_file
    );
    // Ровно на границе — сохраняется.
    let edge = vec![1u8; torrents::MAX_TORRENT_FILE_BYTES];
    assert!(torrents::set_torrent_file(&pool, t.id, &edge)
        .await
        .unwrap());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fill_torrent_file_by_hash_only_fills_empty_rows(pool: PgPool) {
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    assert!(torrents::fill_torrent_file_by_hash(&pool, H1, b"first")
        .await
        .unwrap());
    assert!(!torrents::fill_torrent_file_by_hash(&pool, H1, b"second")
        .await
        .unwrap());
    assert!(!torrents::fill_torrent_file_by_hash(&pool, H2, b"unknown")
        .await
        .unwrap());
    assert_eq!(
        torrents::torrent_file(&pool, t.id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"first"[..])
    );
}

// ------------------------------------------------ шаг 29: пакетные записи и дискографии

async fn seed_tracks(pool: &PgPool, artist: &Artist, album: &Album, n: i32) -> Vec<i64> {
    let mut ids = vec![];
    for p in 1..=n {
        ids.push(
            tracks::upsert_by_mbid_track(pool, &new_track(artist, album, p, Uuid::new_v4()))
                .await
                .unwrap()
                .id,
        );
    }
    ids
}

fn src(
    track_id: i64,
    torrent_id: i64,
    file_index: i32,
    score: f32,
    confirm: bool,
) -> NewTrackSource {
    NewTrackSource {
        track_id,
        torrent_id,
        file_index,
        match_score: score,
        needs_confirmation: confirm,
        cue_start_ms: None,
        cue_end_ms: None,
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn insert_many_is_batched_idempotent_and_keeps_existing_rows(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let ts = seed_tracks(&pool, &artist, &album, 3).await;
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();

    assert_eq!(track_sources::insert_many(&pool, &[]).await.unwrap(), 0);
    let batch: Vec<_> = ts
        .iter()
        .map(|id| src(*id, t.id, *id as i32, 0.9, false))
        .collect();
    assert_eq!(track_sources::insert_many(&pool, &batch).await.unwrap(), 3);
    // Повтор с другими оценками ничего не добавляет и не меняет.
    let again: Vec<_> = ts
        .iter()
        .map(|id| src(*id, t.id, *id as i32, 0.1, true))
        .collect();
    assert_eq!(track_sources::insert_many(&pool, &again).await.unwrap(), 0);
    let kept = track_sources::list_for_track(&pool, ts[0]).await.unwrap();
    assert_eq!(kept.len(), 1);
    assert!((kept[0].match_score - 0.9).abs() < 1e-6 && !kept[0].needs_confirmation);
    assert!(kept[0].cue_start_ms.is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn ensure_primaries_picks_best_and_never_replaces_existing(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let ts = seed_tracks(&pool, &artist, &album, 3).await;
    let a = torrents::upsert_by_info_hash(&pool, &new_torrent(H1))
        .await
        .unwrap();
    let b = torrents::upsert_by_info_hash(&pool, &new_torrent(H2))
        .await
        .unwrap();
    // Трек 0: уверенный 0.6 лучше неуверенного 0.95; трек 1: оценка решает; трек 2: уже есть primary.
    track_sources::insert_many(
        &pool,
        &[
            src(ts[0], a.id, 0, 0.95, true),
            src(ts[0], b.id, 0, 0.6, false),
            src(ts[1], a.id, 1, 0.5, false),
            src(ts[1], b.id, 1, 0.8, false),
            src(ts[2], a.id, 2, 0.4, false),
            src(ts[2], b.id, 2, 0.99, false),
        ],
    )
    .await
    .unwrap();
    let existing = track_sources::find_pair(&pool, ts[2], a.id, 2)
        .await
        .unwrap()
        .unwrap();
    track_sources::set_primary(&pool, ts[2], existing.id)
        .await
        .unwrap();

    assert_eq!(
        track_sources::ensure_primaries(&pool, &[]).await.unwrap(),
        0
    );
    assert_eq!(
        track_sources::ensure_primaries(&pool, &ts).await.unwrap(),
        2
    );
    let primary = |t: i64| {
        let pool = pool.clone();
        async move {
            track_sources::primary_for_track(&pool, t)
                .await
                .unwrap()
                .unwrap()
        }
    };
    assert_eq!(primary(ts[0]).await.torrent_id, b.id);
    assert_eq!(primary(ts[1]).await.torrent_id, b.id);
    assert_eq!(
        primary(ts[2]).await.id,
        existing.id,
        "существующий primary не заменён"
    );
    // Повтор ничего не меняет.
    assert_eq!(
        track_sources::ensure_primaries(&pool, &ts).await.unwrap(),
        0
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn mark_found_changes_only_adding_and_not_found(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let ts = seed_tracks(&pool, &artist, &album, 4).await;
    tracks::set_status(
        &pool,
        ts[1],
        TrackStatus::NotFound,
        Some(NotFoundReason::NoMatch),
    )
    .await
    .unwrap();
    tracks::set_status(&pool, ts[2], TrackStatus::Ready, None)
        .await
        .unwrap();
    tracks::set_status(&pool, ts[3], TrackStatus::Found, None)
        .await
        .unwrap();

    let changed = tracks::mark_found(&pool, &ts).await.unwrap();
    let mut ids: Vec<i64> = changed.iter().map(|t| t.id).collect();
    ids.sort_unstable();
    assert_eq!(ids, [ts[0], ts[1]]);
    assert!(changed
        .iter()
        .all(|t| t.status == TrackStatus::Found && t.status_reason.is_none()));
    assert_eq!(
        tracks::get(&pool, ts[2]).await.unwrap().unwrap().status,
        TrackStatus::Ready
    );
    assert!(tracks::mark_found(&pool, &[]).await.unwrap().is_empty());
}

async fn second_album(pool: &PgPool, artist: &Artist, title: &str) -> Album {
    albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: artist.id,
            title: title.into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_discographies_link_to_any_album_of_the_artist(pool: PgPool) {
    let (artist, album) = seed_album(&pool).await;
    let later = second_album(&pool, &artist, "Later").await;
    let (other_artist, other_album) = {
        let a = artists::upsert_by_mbid(
            &pool,
            &NewArtist {
                mbid: Uuid::new_v4(),
                name: "Other".into(),
                sort_name: None,
                disambiguation: None,
            },
        )
        .await
        .unwrap();
        let al = second_album(&pool, &a, "Elsewhere").await;
        (a, al)
    };
    let mut disco = new_torrent(H1);
    disco.kind = TorrentKind::Discography;
    let disco = torrents::upsert_by_info_hash(&pool, &disco).await.unwrap();
    let plain = torrents::upsert_by_info_hash(&pool, &new_torrent(H2))
        .await
        .unwrap();
    album_torrents::remember_artist_discography(&pool, artist.id, disco.id, "q", 0.3)
        .await
        .unwrap();
    // Повтор сохраняет максимальный ранг; обычная (не дискография) раздача не привязывается.
    album_torrents::remember_artist_discography(&pool, artist.id, disco.id, "q", 0.5)
        .await
        .unwrap();
    album_torrents::remember_artist_discography(&pool, artist.id, plain.id, "q", 0.9)
        .await
        .unwrap();

    assert_eq!(
        album_torrents::link_artist_discographies(&pool, later.id)
            .await
            .unwrap(),
        [disco.id]
    );
    let linked = album_torrents::list_for_album(&pool, later.id)
        .await
        .unwrap();
    assert_eq!(linked.len(), 1);
    assert!((linked[0].rank_score - 0.5).abs() < 1e-6);
    // Повторный вызов — ничего нового.
    assert!(album_torrents::link_artist_discographies(&pool, later.id)
        .await
        .unwrap()
        .is_empty());
    // Чужие артисты не затронуты.
    assert!(
        album_torrents::link_artist_discographies(&pool, other_album.id)
            .await
            .unwrap()
            .is_empty()
    );
    let _ = (album, other_artist);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn has_queued_discover_sees_album_and_artist_jobs_and_honours_ignore_key(pool: PgPool) {
    use nimbus_core::jobs::Job;
    let (artist, album) = seed_album(&pool).await;
    let key_album = format!("discover_album:{}", album.id);
    let key_artist = format!("discover_artist:{}", artist.id);
    assert!(!jobs::has_queued_discover(&pool, album.id, None)
        .await
        .unwrap());

    jobs::enqueue(
        &pool,
        &Job::DiscoverArtist {
            artist_id: artist.id,
        },
        Default::default(),
    )
    .await
    .unwrap();
    assert!(jobs::has_queued_discover(&pool, album.id, None)
        .await
        .unwrap());
    assert!(
        !jobs::has_queued_discover(&pool, album.id, Some(&key_artist))
            .await
            .unwrap()
    );

    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: album.id },
        Default::default(),
    )
    .await
    .unwrap();
    // Артистская задача игнорируется, но альбомная — нет, и наоборот.
    assert!(
        jobs::has_queued_discover(&pool, album.id, Some(&key_artist))
            .await
            .unwrap()
    );
    assert!(jobs::has_queued_discover(&pool, album.id, Some(&key_album))
        .await
        .unwrap());
    sqlx::query("UPDATE jobs SET state = 'done'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!jobs::has_queued_discover(&pool, album.id, None)
        .await
        .unwrap());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn migration_backfills_artist_torrents_from_linked_discographies(pool: PgPool) {
    // Данные «до миграции»: дискография привязана к альбому, строки в artist_torrents нет.
    let (artist, album) = seed_album(&pool).await;
    let mut disco = new_torrent(H1);
    disco.kind = TorrentKind::Discography;
    let disco = torrents::upsert_by_info_hash(&pool, &disco).await.unwrap();
    album_torrents::link(&pool, album.id, disco.id, "q", 0.4)
        .await
        .unwrap();
    sqlx::query("DELETE FROM artist_torrents")
        .execute(&pool)
        .await
        .unwrap();
    // Выполняем backfill-часть миграции повторно: она идемпотентна по смыслу (нет конфликта после очистки).
    let sql = include_str!("../../../migrations/0009_artist_torrents.sql");
    let backfill = &sql[sql.find("INSERT INTO artist_torrents").unwrap()..];
    sqlx::query(backfill).execute(&pool).await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artist_torrents WHERE artist_id = $1 AND torrent_id = $2",
    )
    .bind(artist.id)
    .bind(disco.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn timeout_does_not_downgrade_ok(pool: PgPool) {
    let t = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&"ab".repeat(20)).unwrap(),
            magnet: "magnet:?xt=urn:btih:abababababababababababababababababababab".into(),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "t".into(),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    // `ok` без файлов понижается как обычно.
    let r = torrents::set_meta_status(&pool, t.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    assert_eq!(r.meta_status, MetaStatus::Ok);
    let r = torrents::set_meta_status(&pool, t.id, MetaStatus::Timeout, None)
        .await
        .unwrap();
    assert_eq!(r.meta_status, MetaStatus::Timeout);
    // `ok` с файлами — нет.
    torrents::replace_files(
        &pool,
        t.id,
        &[NewTorrentFile {
            file_index: 0,
            path: "a.flac".into(),
            size_bytes: 1,
            ext: Some("flac".into()),
        }],
    )
    .await
    .unwrap();
    torrents::set_meta_status(&pool, t.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    for st in [
        MetaStatus::Timeout,
        MetaStatus::Dead,
        MetaStatus::Error,
        MetaStatus::Fetching,
    ] {
        let r = torrents::set_meta_status(&pool, t.id, st, Some("late"))
            .await
            .unwrap();
        assert_eq!(
            (r.meta_status, r.meta_attempts),
            (MetaStatus::Ok, 0),
            "{st:?}"
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cue_candidates_mark_failed_and_reset_failed(pool: PgPool) {
    use nimbus_db::repo::cue_candidates;
    let (_, album) = seed_album(&pool).await;
    let t = torrents::upsert_by_info_hash(&pool, &new_torrent(&"ab".repeat(20)))
        .await
        .unwrap();
    for idx in [1, 3, 5] {
        cue_candidates::upsert(&pool, t.id, album.id, idx, 0)
            .await
            .unwrap();
    }
    cue_candidates::mark_failed(&pool, t.id, album.id, 1)
        .await
        .unwrap();
    cue_candidates::mark_processed(&pool, t.id, album.id, 3)
        .await
        .unwrap();
    let rows = cue_candidates::list_for_album(&pool, album.id)
        .await
        .unwrap();
    let flags: Vec<_> = rows.iter().map(|c| (c.processed, c.failed)).collect();
    assert_eq!(flags, [(true, true), (true, false), (false, false)]);
    assert_eq!(
        cue_candidates::count_pending(&pool, album.id)
            .await
            .unwrap(),
        1
    );

    // Сброс возвращает только неудавшихся; окончательно разобранный не трогается.
    assert_eq!(
        cue_candidates::reset_failed(&pool, album.id).await.unwrap(),
        vec![(t.id, 1)]
    );
    let rows = cue_candidates::list_for_album(&pool, album.id)
        .await
        .unwrap();
    let flags: Vec<_> = rows.iter().map(|c| (c.processed, c.failed)).collect();
    assert_eq!(flags, [(false, false), (true, false), (false, false)]);
    assert!(cue_candidates::reset_failed(&pool, album.id)
        .await
        .unwrap()
        .is_empty());
}

async fn pinned_track(pool: &PgPool) -> (i64, i64) {
    let (artist, album) = seed_album(pool).await;
    let t = tracks::upsert_by_mbid_track(
        pool,
        &NewTrack {
            mbid_recording: Uuid::new_v4(),
            mbid_track: None,
            album_id: album.id,
            artist_id: artist.id,
            title: "T".into(),
            disc_no: 1,
            position: 1,
            duration_ms: None,
        },
    )
    .await
    .unwrap();
    tracks::set_status(pool, t.id, TrackStatus::Found, None)
        .await
        .unwrap();
    pins::pin_tracks(pool, &[t.id], false).await.unwrap();
    (album.id, t.id)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_fail_schedules_retry_and_counts_only_on_request(pool: PgPool) {
    let (_, t) = pinned_track(&pool).await;
    let soon = chrono::Utc::now() + chrono::Duration::hours(1);
    pins::fail(&pool, t, "storage: x", Some(soon), false)
        .await
        .unwrap();
    let p = pins::get(&pool, t).await.unwrap().unwrap();
    assert_eq!((p.state, p.retries), (PinState::Failed, 0));
    assert_eq!(p.error.as_deref(), Some("storage: x"));
    assert!(p.next_retry_at.is_some());
    // Срок не наступил — не повторяется.
    assert!(pins::retry_failed(&pool).await.unwrap().is_empty());

    pins::fail(&pool, t, "stalled", Some(chrono::Utc::now()), true)
        .await
        .unwrap();
    assert_eq!(pins::get(&pool, t).await.unwrap().unwrap().retries, 1);
    assert_eq!(pins::retry_failed(&pool).await.unwrap(), vec![t]);
    let p = pins::get(&pool, t).await.unwrap().unwrap();
    // `retries` — ступень расписания, повтор её не сбрасывает.
    assert_eq!(
        (p.state, p.error, p.retries, p.next_retry_at),
        (PinState::Queued, None, 1, None)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_without_schedule_is_never_retried(pool: PgPool) {
    let (_, t) = pinned_track(&pool).await;
    pins::fail(&pool, t, "dead", None, true).await.unwrap();
    assert!(pins::retry_failed(&pool).await.unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_reset_retries_and_requeue_clear_the_schedule(pool: PgPool) {
    let (_, t) = pinned_track(&pool).await;
    pins::set_retries(&pool, t, 3).await.unwrap();
    pins::reset_retries(&pool, t).await.unwrap();
    assert_eq!(pins::get(&pool, t).await.unwrap().unwrap().retries, 0);

    for (name, revive) in [("requeue", 0), ("pin_tracks", 1)] {
        pins::fail(&pool, t, "stalled", Some(chrono::Utc::now()), true)
            .await
            .unwrap();
        if revive == 0 {
            pins::requeue(&pool, t).await.unwrap();
        } else {
            pins::pin_tracks(&pool, &[t], false).await.unwrap();
        }
        let p = pins::get(&pool, t).await.unwrap().unwrap();
        assert_eq!(
            (p.state, p.error, p.retries, p.next_retry_at),
            (PinState::Queued, None, 0, None),
            "{name}"
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stalled_pins_need_sources_and_new_sources_requeue_them(pool: PgPool) {
    let (album_id, t) = pinned_track(&pool).await;
    assert!(!pins::album_needs_sources(&pool, album_id).await.unwrap());
    pins::fail(&pool, t, "storage: x", None, false)
        .await
        .unwrap();
    assert!(!pins::album_needs_sources(&pool, album_id).await.unwrap());
    assert!(pins::requeue_stalled_for_tracks(&pool, &[t])
        .await
        .unwrap()
        .is_empty());
    pins::fail(&pool, t, "dead", None, true).await.unwrap();
    assert!(pins::album_needs_sources(&pool, album_id).await.unwrap());
    assert_eq!(
        pins::requeue_stalled_for_tracks(&pool, &[t]).await.unwrap(),
        vec![t]
    );
    assert_eq!(
        pins::get(&pool, t).await.unwrap().unwrap().state,
        PinState::Queued
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn searched_within_looks_at_the_last_search_start(pool: PgPool) {
    let (album_id, _) = pinned_track(&pool).await;
    let day = Duration::from_secs(86_400);
    assert!(!acquisition::searched_within(&pool, album_id, day)
        .await
        .unwrap());
    acquisition::mark_search_started(&pool, album_id)
        .await
        .unwrap();
    assert!(acquisition::searched_within(&pool, album_id, day)
        .await
        .unwrap());
    assert!(
        !acquisition::searched_within(&pool, album_id, Duration::ZERO)
            .await
            .unwrap()
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrent_upload_accumulates_across_sessions(pool: PgPool) {
    let h = "a".repeat(40);
    let total = |m: std::collections::HashMap<String, u64>| m[&h];
    assert_eq!(
        total(
            torrent_upload::record(&pool, &[(h.clone(), 100)])
                .await
                .unwrap()
        ),
        100
    );
    assert_eq!(
        total(
            torrent_upload::record(&pool, &[(h.clone(), 250)])
                .await
                .unwrap()
        ),
        250
    );
    // Перезапуск: счётчик сессии сбросился.
    assert_eq!(
        total(
            torrent_upload::record(&pool, &[(h.clone(), 30)])
                .await
                .unwrap()
        ),
        280
    );
    assert_eq!(
        total(
            torrent_upload::record(&pool, &[(h.clone(), 30)])
                .await
                .unwrap()
        ),
        280
    );
    assert!(torrent_upload::record(&pool, &[]).await.unwrap().is_empty());
    // Удаление торрента стирает историю: новый торрент с тем же хешем начинает с нуля.
    torrent_upload::forget(&pool, &[h.clone()]).await.unwrap();
    assert_eq!(
        total(
            torrent_upload::record(&pool, &[(h.clone(), 7)])
                .await
                .unwrap()
        ),
        7
    );
}
