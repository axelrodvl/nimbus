// Перекодирование: фейковый «ffmpeg» — shell-скрипт (`#!/bin/sh`, без bash).
#![allow(clippy::unwrap_used)]
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use common::{router, state};
use http_body_util::BodyExt;
use nimbus_api::transcode::Transcoder;
use nimbus_api::AppState;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, downloads, torrents, track_sources, tracks};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

/// Скрипт: `body` выполняется после записи аргументов в `<dir>/args`.
fn fake_ffmpeg(dir: &Path, body: &str) -> String {
    let script = dir.join("ffmpeg");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo fake; exit 0; fi\n\
             echo \"$@\" > \"{d}/args\"\n{body}\n",
            d = dir.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

struct Fx {
    dir: PathBuf,
    uri: String,
    st: AppState,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Трек `wv` (нужно перекодирование) с завершённым файлом на диске.
async fn fx(pool: PgPool, ffmpeg_body: &str, duration_ms: Option<i32>) -> Fx {
    let dir = std::env::temp_dir().join(format!("nimbus-tc-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.wv");
    std::fs::write(&file, b"0123456789").unwrap();

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
            title: "T".into(),
            disc_no: 1,
            position: 1,
            duration_ms,
        },
    )
    .await
    .unwrap();
    tracks::set_status(&pool, track.id, TrackStatus::Ready, None)
        .await
        .unwrap();
    let hash = InfoHash::parse(&"ab".repeat(20)).unwrap();
    let t = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: hash.clone(),
            magnet: format!("magnet:?xt=urn:btih:{hash}"),
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
    torrents::replace_files(
        &pool,
        t.id,
        &[NewTorrentFile {
            file_index: 0,
            path: "a.wv".into(),
            size_bytes: 10,
            ext: Some("wv".into()),
        }],
    )
    .await
    .unwrap();
    let src = track_sources::insert(
        &pool,
        &NewTrackSource {
            track_id: track.id,
            torrent_id: t.id,
            file_index: 0,
            match_score: 0.9,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    track_sources::set_primary(&pool, track.id, src.id)
        .await
        .unwrap();
    downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: t.id,
            file_index: 0,
            local_path: file.to_string_lossy().into_owned(),
            bytes_total: 10,
            bytes_done: 10,
        },
    )
    .await
    .unwrap();
    downloads::mark_completed(&pool, t.id, 0).await.unwrap();

    let ffmpeg = fake_ffmpeg(&dir, ffmpeg_body);
    let mut st = state(pool).with_transcoder(Transcoder::new(ffmpeg).with_available(true));
    st.first_byte_timeout = Duration::from_millis(300);
    st.stream_idle_timeout = Duration::from_millis(300);
    Fx {
        dir,
        uri: format!("/api/tracks/{}/stream", track.id),
        st,
    }
}

async fn get(f: &Fx, uri: &str) -> axum::response::Response {
    router(f.st.clone())
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn body_text(res: axum::response::Response) -> String {
    String::from_utf8_lossy(&res.into_body().collect().await.unwrap().to_bytes()).into_owned()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn success_has_headers_and_streams_the_body(pool: PgPool) {
    let f = fx(pool, "printf 'fLaC-ok'", Some(123_000)).await;
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["x-nimbus-transcode"], "1");
    assert_eq!(r.headers()["x-nimbus-duration-ms"], "123000");
    assert_eq!(r.headers()["content-type"], "audio/flac");
    assert_eq!(body_text(r).await, "fLaC-ok");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn offset_parameter_reaches_the_arguments(pool: PgPool) {
    let f = fx(pool, "printf 'x'", None).await;
    let r = get(&f, &format!("{}?t=12.5", f.uri)).await;
    assert_eq!(r.status(), 200);
    let args = std::fs::read_to_string(f.dir.join("args")).unwrap();
    assert!(args.contains("-ss 12.500 -i "), "{args}");
    // Мусорные значения игнорируются.
    let r = get(&f, &format!("{}?t=-3", f.uri)).await;
    assert_eq!(r.status(), 200);
    let args = std::fs::read_to_string(f.dir.join("args")).unwrap();
    assert!(args.contains("-ss 0.000 -i "), "{args}");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn silent_ffmpeg_gives_504(pool: PgPool) {
    let f = fx(pool, "exec sleep 30", None).await;
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 504);
    assert!(body_text(r).await.contains("no_peers"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn crashing_ffmpeg_gives_502(pool: PgPool) {
    let f = fx(pool, "exit 1", None).await;
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 502);
    assert!(body_text(r).await.contains("transcode_failed"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fifth_concurrent_transcode_is_busy(pool: PgPool) {
    let f = fx(pool, "printf 'x'; exec sleep 30", None).await;
    let mut held = vec![];
    for _ in 0..4 {
        let r = get(&f, &f.uri).await;
        assert_eq!(r.status(), 200);
        held.push(r);
    }
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 503);
    assert!(body_text(r).await.contains("transcoder_busy"));
    drop(held);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn ffmpeg_stalling_mid_stream_cuts_the_connection(pool: PgPool) {
    let f = fx(pool, "printf 'fLaC'; exec sleep 30", None).await;
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 200);
    let mut body = r.into_body();
    let mut got = 0;
    let err = loop {
        match body.frame().await {
            Some(Ok(fr)) => got += fr.into_data().map(|d| d.len()).unwrap_or(0),
            Some(Err(e)) => break e.to_string(),
            None => panic!("ожидали обрыв по таймауту простоя"),
        }
    };
    assert_eq!(got, 4);
    assert!(!err.is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn download_flag_names_the_file_flac(pool: PgPool) {
    let f = fx(pool, "printf 'x'", None).await;
    let r = get(&f, &format!("{}?download=1", f.uri)).await;
    assert_eq!(r.status(), 200);
    let d = r.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(d.starts_with("attachment; filename=\"01 - T.flac\""), "{d}");
}

// ---- audio_info: фейковый ffmpeg печатает в stderr, как настоящий `ffmpeg -i`

async fn info(f: &Fx) -> (u16, serde_json::Value) {
    let uri = f.uri.replace("/stream", "/audio-info");
    let r = get(f, &uri).await;
    let status = r.status().as_u16();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn audio_info_parses_the_ffmpeg_report(pool: PgPool) {
    let f = fx(
        pool,
        "echo '  Duration: 00:01:00.00, bitrate: 900 kb/s' >&2\n\
         echo '  Stream #0:0: Audio: wavpack, 96000 Hz, stereo, s32 (24 bit)' >&2\nexit 1",
        None,
    )
    .await;
    let (s, v) = info(&f).await;
    assert_eq!(s, 200);
    assert_eq!(v["ext"], "wv");
    assert_eq!(v["codec"], "wavpack");
    assert_eq!(v["sample_rate"], 96000);
    assert_eq!(v["bit_depth"], 24);
    assert_eq!(v["channels"], "stereo");
    assert_eq!(v["bitrate_kbps"], 900);
    assert_eq!(v["transcoded"], true);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn audio_info_without_ffmpeg_still_reports_the_extension(pool: PgPool) {
    let mut f = fx(pool, "exit 1", None).await;
    f.st =
        f.st.clone()
            .with_transcoder(Transcoder::new("/nonexistent/ffmpeg"));
    let (s, v) = info(&f).await;
    assert_eq!(
        (s, v["ext"].as_str(), v["codec"].is_null()),
        (200, Some("wv"), true)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn audio_info_survives_garbage_output_and_errors(pool: PgPool) {
    let f = fx(pool.clone(), "echo garbage >&2", None).await;
    let (s, v) = info(&f).await;
    assert_eq!((s, v["codec"].is_null()), (200, true));

    assert_eq!(
        common::get_json(router(f.st.clone()), "/api/tracks/999999/audio-info")
            .await
            .0,
        404
    );
    sqlx::query("UPDATE tracks SET status = 'adding'")
        .execute(&pool)
        .await
        .unwrap();
    let (s, v) = info(&f).await;
    assert_eq!(
        (s, v["error"]["code"].as_str()),
        (409, Some("track_not_playable"))
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn probe_detects_a_working_and_a_missing_ffmpeg(pool: PgPool) {
    let f = fx(pool, "exit 0", None).await;
    let ok = Transcoder::new(f.dir.join("ffmpeg").to_string_lossy())
        .probe()
        .await;
    assert!(ok.available);
    assert!(
        !Transcoder::new("/nonexistent/ffmpeg")
            .probe()
            .await
            .available
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unstartable_ffmpeg_gives_503(pool: PgPool) {
    let mut f = fx(pool, "exit 0", None).await;
    f.st =
        f.st.clone()
            .with_transcoder(Transcoder::new("/nonexistent/ffmpeg").with_available(true));
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 503);
    assert!(body_text(r).await.contains("ffmpeg_missing"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn seeking_past_the_cue_segment_gives_an_empty_body(pool: PgPool) {
    let f = fx(pool.clone(), "printf 'x'", None).await;
    sqlx::query("UPDATE track_sources SET cue_start_ms = 0, cue_end_ms = 1000")
        .execute(&pool)
        .await
        .unwrap();
    let r = get(&f, &format!("{}?t=5", f.uri)).await;
    assert_eq!(r.status(), 200);
    assert_eq!(body_text(r).await, "");
    assert!(!f.dir.join("args").exists(), "ffmpeg не запускался");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_a_local_file_and_raw_base_the_engine_is_unavailable(pool: PgPool) {
    let f = fx(pool.clone(), "exit 0", None).await;
    sqlx::query("DELETE FROM downloads")
        .execute(&pool)
        .await
        .unwrap();
    let r = get(&f, &f.uri).await;
    assert_eq!(r.status(), 503);
    assert!(body_text(r).await.contains("engine_unavailable"));
}
