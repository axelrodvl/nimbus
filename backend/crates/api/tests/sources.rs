// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{get_json, post_json, request_json, router, state};
use nimbus_api::AppState;
use nimbus_core::model::{
    InfoHash, MetaStatus, NewAlbum, NewArtist, NewTorrent, NewTorrentFile, NewTrack,
    NewTrackSource, TorrentKind, TorrentSource, TrackStatus,
};
use nimbus_db::repo::{
    album_torrents, albums, artists, downloads, jobs, torrents, track_sources, tracks,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

struct World {
    album_id: i64,
    track_id: i64,
    other_track_id: i64,
    torrent_id: i64,
}

async fn world(pool: &PgPool, status: TrackStatus) -> World {
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
            title: "B".into(),
            primary_type: None,
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let mut ids = vec![];
    for pos in 1..=2 {
        let t = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: album.id,
                artist_id: artist.id,
                title: format!("Song {pos}"),
                disc_no: 1,
                position: pos,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        tracks::set_status(pool, t.id, status, None).await.unwrap();
        ids.push(t.id);
    }
    let torrent = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse("c12fe1c06bba254a9dc9f519b335aa7c1367a88a").unwrap(),
            magnet: "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a".into(),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "A - B [FLAC]".into(),
            size_bytes: Some(1000),
            seeders: Some(5),
            leechers: Some(1),
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    torrents::set_meta_status(pool, torrent.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    let files: Vec<NewTorrentFile> = (0..2)
        .map(|i| NewTorrentFile {
            file_index: i,
            path: format!("B/0{}. Song.flac", i + 1),
            size_bytes: 500,
            ext: Some("flac".into()),
        })
        .collect();
    torrents::replace_files(pool, torrent.id, &files)
        .await
        .unwrap();
    album_torrents::link(pool, album.id, torrent.id, "q", 0.8)
        .await
        .unwrap();
    World {
        album_id: album.id,
        track_id: ids[0],
        other_track_id: ids[1],
        torrent_id: torrent.id,
    }
}

async fn add_source(pool: &PgPool, w: &World, track: i64, file: i32, confirm: bool) -> i64 {
    track_sources::insert(
        pool,
        &NewTrackSource {
            track_id: track,
            torrent_id: w.torrent_id,
            file_index: file,
            match_score: 0.7,
            needs_confirmation: confirm,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap()
    .id
}

fn app(pool: PgPool) -> (axum::Router, AppState) {
    let st: AppState = state(pool);
    (router(st.clone()), st)
}

async fn status_of(pool: &PgPool, id: i64) -> TrackStatus {
    tracks::get(pool, id).await.unwrap().unwrap().status
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn lists_torrents_files_and_sources(pool: PgPool) {
    let w = world(&pool, TrackStatus::Found).await;
    let s = add_source(&pool, &w, w.track_id, 0, true).await;
    track_sources::set_primary(&pool, w.track_id, s)
        .await
        .unwrap();
    let (app, _) = app(pool);

    let (code, body) = get_json(app.clone(), &format!("/api/albums/{}/torrents", w.album_id)).await;
    assert_eq!(code, 200);
    assert_eq!(body[0]["torrent"]["source"], "tpb");
    assert_eq!(body[0]["torrent"]["meta_status"], "ok");
    assert_eq!(body[0]["files_count"], 2);
    assert_eq!(body[0]["matched_tracks"], 1);

    let (code, body) = get_json(
        app.clone(),
        &format!("/api/torrents/{}/files", w.torrent_id),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(body[0]["matched_track_id"], w.track_id);
    assert!(body[1]["matched_track_id"].is_null());

    let (code, body) = get_json(app.clone(), &format!("/api/tracks/{}/sources", w.track_id)).await;
    assert_eq!(code, 200);
    assert_eq!(body[0]["id"], s);
    assert_eq!(body[0]["is_primary"], true);
    assert_eq!(body[0]["needs_confirmation"], true);
    assert_eq!(body[0]["path"], "B/01. Song.flac");

    for uri in [
        "/api/albums/999999/torrents",
        "/api/torrents/999999/files",
        "/api/tracks/999999/sources",
    ] {
        assert_eq!(get_json(app.clone(), uri).await.0, 404, "{uri}");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn put_source_by_pair_creates_primary_and_found(pool: PgPool) {
    let w = world(&pool, TrackStatus::NotFound).await;
    let (app, st) = app(pool.clone());
    let mut rx = st.events.subscribe();

    let (code, body) = request_json(
        app.clone(),
        "PUT",
        &format!("/api/tracks/{}/source", w.track_id),
        Some(json!({ "torrent_id": w.torrent_id, "file_index": 1 })),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["is_primary"], true);
    assert_eq!(body["needs_confirmation"], false);
    assert_eq!(body["file_index"], 1);
    assert!((body["match_score"].as_f64().unwrap() - 1.0).abs() < 1e-6);
    assert_eq!(status_of(&pool, w.track_id).await, TrackStatus::Found);
    let ev = rx.recv().await.unwrap();
    assert!(matches!(
        ev,
        nimbus_core::events::Event::TrackStatus {
            status: TrackStatus::Found,
            ..
        }
    ));

    // Несуществующий файл и неполное тело.
    let uri = format!("/api/tracks/{}/source", w.track_id);
    let (c, _) = request_json(
        app.clone(),
        "PUT",
        &uri,
        Some(json!({ "torrent_id": w.torrent_id, "file_index": 77 })),
    )
    .await;
    assert_eq!(c, 404);
    let (c, _) = request_json(
        app.clone(),
        "PUT",
        &uri,
        Some(json!({ "torrent_id": w.torrent_id })),
    )
    .await;
    assert_eq!(c, 400);
    let (c, _) = request_json(app, "PUT", &uri, Some(json!({ "source_id": 424242 }))).await;
    assert_eq!(c, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn put_source_by_id_switches_primary_and_respects_download(pool: PgPool) {
    let w = world(&pool, TrackStatus::Found).await;
    let a = add_source(&pool, &w, w.track_id, 0, false).await;
    let b = add_source(&pool, &w, w.track_id, 1, false).await;
    track_sources::set_primary(&pool, w.track_id, a)
        .await
        .unwrap();
    // Файл 1 уже скачан.
    downloads::upsert(
        &pool,
        &nimbus_core::model::NewDownload {
            torrent_id: w.torrent_id,
            file_index: 1,
            local_path: "x".into(),
            bytes_total: 500,
            bytes_done: 500,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&pool, w.torrent_id, 1)
        .await
        .unwrap();
    let (app, _) = app(pool.clone());

    let (code, body) = request_json(
        app,
        "PUT",
        &format!("/api/tracks/{}/source", w.track_id),
        Some(json!({ "source_id": b })),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["id"], b);
    let primary = track_sources::primary_for_track(&pool, w.track_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(primary.id, b);
    assert_eq!(status_of(&pool, w.track_id).await, TrackStatus::Ready);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn source_of_another_track_is_rejected(pool: PgPool) {
    let w = world(&pool, TrackStatus::Found).await;
    let foreign = add_source(&pool, &w, w.other_track_id, 1, false).await;
    let (app, _) = app(pool);
    let (code, _) = request_json(
        app,
        "PUT",
        &format!("/api/tracks/{}/source", w.track_id),
        Some(json!({ "source_id": foreign })),
    )
    .await;
    assert_eq!(code, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn confirm_clears_flag(pool: PgPool) {
    let w = world(&pool, TrackStatus::Found).await;
    let s = add_source(&pool, &w, w.track_id, 0, true).await;
    let (app, _) = app(pool.clone());
    let uri = format!("/api/tracks/{}/sources/{s}/confirm", w.track_id);
    let (code, body) = post_json(app.clone(), &uri, json!({})).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["needs_confirmation"], false);
    assert!(
        !track_sources::get(&pool, s)
            .await
            .unwrap()
            .unwrap()
            .needs_confirmation
    );
    let (code, _) = post_json(
        app,
        &format!("/api/tracks/{}/sources/{s}/confirm", w.other_track_id),
        json!({}),
    )
    .await;
    assert_eq!(code, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_track_enqueues_discover_and_sets_adding(pool: PgPool) {
    let w = world(&pool, TrackStatus::NotFound).await;
    let (app, _) = app(pool.clone());
    let uri = format!("/api/tracks/{}/retry", w.track_id);
    let (code, body) = post_json(app.clone(), &uri, json!({})).await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(body["queued"], true);
    assert_eq!(status_of(&pool, w.track_id).await, TrackStatus::Adding);
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].kind, "discover_album");
    assert_eq!(
        queued[0].priority, 10,
        "действие пользователя — интерактивный приоритет"
    );
    // Повтор: задача уже в очереди (dedup).
    let (_, body) = post_json(app.clone(), &uri, json!({})).await;
    assert_eq!(body["queued"], false);
    // Ready не перезапускаем.
    tracks::set_status(&pool, w.track_id, TrackStatus::Ready, None)
        .await
        .unwrap();
    let (code, _) = post_json(app, &uri, json!({})).await;
    assert_eq!(code, 409);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_album_resets_not_found_and_timeouts(pool: PgPool) {
    let w = world(&pool, TrackStatus::NotFound).await;
    tracks::set_status(&pool, w.other_track_id, TrackStatus::Ready, None)
        .await
        .unwrap();
    // Напрямую: `set_meta_status` не понижает `ok` с файлами, а здесь нужен именно таймаут.
    sqlx::query("UPDATE torrents SET meta_status = 'timeout' WHERE id = $1")
        .bind(w.torrent_id)
        .execute(&pool)
        .await
        .unwrap();
    album_torrents::mark_verified(&pool, w.album_id, w.torrent_id)
        .await
        .unwrap();
    let (app, _) = app(pool.clone());

    let (code, body) =
        post_json(app, &format!("/api/albums/{}/retry", w.album_id), json!({})).await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(body["tracks_reset"], 1);
    assert_eq!(status_of(&pool, w.track_id).await, TrackStatus::Adding);
    assert_eq!(status_of(&pool, w.other_track_id).await, TrackStatus::Ready);
    assert_eq!(
        album_torrents::count_unverified(&pool, w.album_id)
            .await
            .unwrap(),
        1
    );
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].priority, 10);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn manual_magnet_creates_torrent_and_verify_job(pool: PgPool) {
    let w = world(&pool, TrackStatus::Adding).await;
    let (app, _) = app(pool.clone());
    let uri = format!("/api/albums/{}/torrents", w.album_id);
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let (code, body) = post_json(
        app.clone(),
        &uri,
        json!({ "magnet": format!("magnet:?xt=urn:btih:{hash}&dn=My+Own%20Rip") }),
    )
    .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(body["torrent"]["source"], "manual");
    assert_eq!(body["torrent"]["title"], "My Own Rip");
    assert_eq!(body["queued"], true);

    let t = body["torrent"]["id"].as_i64().unwrap();
    let linked = album_torrents::list_for_album(&pool, w.album_id)
        .await
        .unwrap();
    let l = linked.iter().find(|r| r.torrent.id == t).unwrap();
    assert_eq!(l.torrent.source, TorrentSource::Manual);
    assert!((l.rank_score - 1.0).abs() < 1e-6);
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert!(queued.iter().any(|j| j.kind == "verify_torrent"
        && j.priority == 10
        && j.payload == json!({ "torrent_id": t, "album_id": w.album_id })));

    // Без dn= заголовок — хэш.
    let h2 = "89abcdef0123456789abcdef0123456789abcdef";
    let (_, body) = post_json(
        app,
        &uri,
        json!({ "magnet": format!("magnet:?xt=urn:btih:{h2}") }),
    )
    .await;
    assert_eq!(body["torrent"]["title"], h2);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invalid_magnet_is_400(pool: PgPool) {
    let w = world(&pool, TrackStatus::Adding).await;
    let (app, _) = app(pool.clone());
    for m in [
        "",
        "http://example.com",
        "magnet:?dn=x",
        "magnet:?xt=urn:btih:short",
    ] {
        let (code, body) = post_json(
            app.clone(),
            &format!("/api/albums/{}/torrents", w.album_id),
            json!({ "magnet": m }),
        )
        .await;
        assert_eq!(code, 400, "{m}");
        assert_eq!(body["error"]["code"], "invalid_magnet");
    }
    assert_eq!(jobs::list(&pool, None, 10).await.unwrap().len(), 0);
}

/// Вторая раздача альбома (MP3), с которой треки уже скачаны: primary — она, файлы лежат на диске.
async fn mp3_torrent_in_use(pool: &PgPool, w: &World, dir: &std::path::Path) -> i64 {
    let torrent = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse("d12fe1c06bba254a9dc9f519b335aa7c1367a88a").unwrap(),
            magnet: "magnet:?xt=urn:btih:d12fe1c06bba254a9dc9f519b335aa7c1367a88a".into(),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "A - B (2001) MP3 320".into(),
            size_bytes: Some(100),
            seeders: Some(1),
            leechers: Some(0),
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    torrents::set_meta_status(pool, torrent.id, MetaStatus::Ok, None)
        .await
        .unwrap();
    let files: Vec<NewTorrentFile> = (0..2)
        .map(|i| NewTorrentFile {
            file_index: i,
            path: format!("A - B/0{}. Song {}.mp3", i + 1, i + 1),
            size_bytes: 50,
            ext: Some("mp3".into()),
        })
        .collect();
    torrents::replace_files(pool, torrent.id, &files)
        .await
        .unwrap();
    album_torrents::link(pool, w.album_id, torrent.id, "q", 0.9)
        .await
        .unwrap();
    for (i, track) in [w.track_id, w.other_track_id].into_iter().enumerate() {
        let s = track_sources::insert(
            pool,
            &NewTrackSource {
                track_id: track,
                torrent_id: torrent.id,
                file_index: i as i32,
                match_score: 0.9,
                needs_confirmation: false,
                cue_start_ms: None,
                cue_end_ms: None,
            },
        )
        .await
        .unwrap();
        track_sources::set_primary(pool, track, s.id).await.unwrap();
        let path = dir.join(format!("{i}.mp3"));
        std::fs::write(&path, b"mp3").unwrap();
        downloads::upsert(
            pool,
            &nimbus_core::model::NewDownload {
                torrent_id: torrent.id,
                file_index: i as i32,
                local_path: path.to_string_lossy().into_owned(),
                bytes_total: 3,
                bytes_done: 3,
            },
        )
        .await
        .unwrap();
        downloads::mark_completed(pool, torrent.id, i as i32)
            .await
            .unwrap();
    }
    torrent.id
}

/// Файлы FLAC-раздачи из `world` с названиями треков (как в настоящей раздаче).
async fn flac_files_named(pool: &PgPool, w: &World) {
    let files: Vec<NewTorrentFile> = (0..2)
        .map(|i| NewTorrentFile {
            file_index: i,
            path: format!("A - B [FLAC]/0{}. Song {}.flac", i + 1, i + 1),
            size_bytes: 500,
            ext: Some("flac".into()),
        })
        .collect();
    torrents::replace_files(pool, w.torrent_id, &files)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn use_torrent_switches_album_and_deletes_old_server_copy(pool: PgPool) {
    let w = world(&pool, TrackStatus::Ready).await;
    flac_files_named(&pool, &w).await;
    let dir = tempfile::tempdir().unwrap();
    let mp3 = mp3_torrent_in_use(&pool, &w, dir.path()).await;
    nimbus_db::repo::pins::pin_tracks(&pool, &[w.track_id], false)
        .await
        .unwrap();
    nimbus_db::repo::pins::set_state(&pool, w.track_id, nimbus_core::model::PinState::Done, None)
        .await
        .unwrap();
    let (app, _) = app(pool.clone());

    let uri = format!("/api/albums/{}/torrents/{}/use", w.album_id, w.torrent_id);
    let (code, body) = post_json(app.clone(), &uri, json!({})).await;
    assert_eq!(code, 200, "{body}");
    let mut switched: Vec<i64> = body["switched_track_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    switched.sort_unstable();
    assert_eq!(switched, vec![w.track_id, w.other_track_id]);
    assert_eq!(body["matched"], 2);
    assert_eq!(body["unmatched"], 0);

    for track in [w.track_id, w.other_track_id] {
        let p = track_sources::primary_for_track(&pool, track)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(p.torrent_id, w.torrent_id);
        // Новый файл не скачан — трек снова `found`.
        assert_eq!(status_of(&pool, track).await, TrackStatus::Found);
    }
    // Серверная копия MP3 удалена: и файлы, и учёт.
    for i in 0..2 {
        assert!(!dir.path().join(format!("{i}.mp3")).exists());
        assert!(downloads::get(&pool, mp3, i).await.unwrap().is_none());
    }
    // Закреплённый трек снова в очереди: серверу нужно скачать новый файл.
    let pin = nimbus_db::repo::pins::get(&pool, w.track_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pin.state, nimbus_core::model::PinState::Queued);

    // Список раздач: какая используется и какие внутри форматы.
    let (_, list) = get_json(app.clone(), &format!("/api/albums/{}/torrents", w.album_id)).await;
    let by_id = |id: i64| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|r| r["torrent"]["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(by_id(w.torrent_id)["primary_tracks"], 2);
    assert_eq!(by_id(w.torrent_id)["formats"], json!(["FLAC"]));
    assert_eq!(by_id(mp3)["primary_tracks"], 0);
    assert_eq!(by_id(mp3)["formats"], json!(["MP3"]));

    // Повтор ничего не меняет.
    let (code, body) = post_json(app, &uri, json!({})).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["switched_track_ids"], json!([]));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn use_torrent_keeps_file_still_needed_by_another_track(pool: PgPool) {
    let w = world(&pool, TrackStatus::Ready).await;
    flac_files_named(&pool, &w).await;
    let dir = tempfile::tempdir().unwrap();
    let mp3 = mp3_torrent_in_use(&pool, &w, dir.path()).await;
    // Во FLAC-раздаче только первый трек: второй остаётся на MP3, его файл не трогаем.
    torrents::replace_files(
        &pool,
        w.torrent_id,
        &[NewTorrentFile {
            file_index: 0,
            path: "A - B [FLAC]/01. Song 1.flac".into(),
            size_bytes: 500,
            ext: Some("flac".into()),
        }],
    )
    .await
    .unwrap();
    let (app, _) = app(pool.clone());

    let uri = format!("/api/albums/{}/torrents/{}/use", w.album_id, w.torrent_id);
    let (code, body) = post_json(app, &uri, json!({})).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["switched_track_ids"], json!([w.track_id]));
    assert_eq!(body["unmatched"], 1);
    assert!(!dir.path().join("0.mp3").exists());
    assert!(dir.path().join("1.mp3").exists());
    assert!(downloads::get(&pool, mp3, 1).await.unwrap().is_some());
    assert_eq!(status_of(&pool, w.other_track_id).await, TrackStatus::Ready);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn use_torrent_errors(pool: PgPool) {
    let w = world(&pool, TrackStatus::Found).await;
    let (app, _) = app(pool.clone());
    let uri = |album: i64, torrent: i64| format!("/api/albums/{album}/torrents/{torrent}/use");

    let (c, _) = post_json(app.clone(), &uri(999_999, w.torrent_id), json!({})).await;
    assert_eq!(c, 404);
    let (c, _) = post_json(app.clone(), &uri(w.album_id, 999_999), json!({})).await;
    assert_eq!(c, 404);

    // Только аудио, которое не похоже на треки альбома → no_match, ничего не меняется.
    torrents::replace_files(
        &pool,
        w.torrent_id,
        &[NewTorrentFile {
            file_index: 0,
            path: "cover.jpg".into(),
            size_bytes: 5,
            ext: Some("jpg".into()),
        }],
    )
    .await
    .unwrap();
    let (c, body) = post_json(app.clone(), &uri(w.album_id, w.torrent_id), json!({})).await;
    assert_eq!(c, 409, "{body}");
    assert_eq!(body["error"]["code"], "no_match");

    // Метаданные ещё не получены (файлов нет).
    torrents::replace_files(&pool, w.torrent_id, &[])
        .await
        .unwrap();
    torrents::set_meta_status(&pool, w.torrent_id, MetaStatus::Fetching, None)
        .await
        .unwrap();
    let (c, body) = post_json(app, &uri(w.album_id, w.torrent_id), json!({})).await;
    assert_eq!(c, 409);
    assert_eq!(body["error"]["code"], "torrent_no_files");
}
