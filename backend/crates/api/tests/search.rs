mod common;

use std::time::Duration;

use common::{get_json, mb_client, router, state_with_mb};
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, tracks};
use sqlx::PgPool;
use uuid::Uuid;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const RADIOHEAD: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OK_COMPUTER: &str = "b1392450-e666-3926-a536-22c65f834433";
const PARANOID_REC: &str = "8c2a6b1d-1f5e-4a3b-9c7d-2e4f6a8b0c12";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/../musicbrainz/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn json(name: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(fixture(name), "application/json")
}

async fn mb_with_all() -> MockServer {
    let server = MockServer::start().await;
    for (p, f) in [
        ("/ws/2/artist", "search_artist"),
        ("/ws/2/release-group", "search_release_group"),
        ("/ws/2/recording", "search_recording"),
    ] {
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(json(f))
            .mount(&server)
            .await;
    }
    server
}

fn u(s: &str) -> Uuid {
    Uuid::parse_str(s).unwrap()
}

async fn seed_library(pool: &PgPool) -> (i64, i64, i64) {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: u(RADIOHEAD),
            name: "Radiohead".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    artists::set_in_library(pool, artist.id, true)
        .await
        .unwrap();
    let album = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: u(OK_COMPUTER),
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
    albums::set_in_library(pool, album.id, true).await.unwrap();
    let track = tracks::upsert_by_mbid_track(
        pool,
        &NewTrack {
            mbid_recording: u(PARANOID_REC),
            mbid_track: Some(Uuid::new_v4()),
            album_id: album.id,
            artist_id: artist.id,
            title: "Paranoid Android".into(),
            disc_no: 1,
            position: 2,
            duration_ms: Some(387_000),
        },
    )
    .await
    .unwrap();
    tracks::set_in_library(pool, track.id, true).await.unwrap();
    tracks::set_status(pool, track.id, TrackStatus::Found, None)
        .await
        .unwrap();
    (artist.id, album.id, track.id)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn search_returns_all_three_lists_with_library_ids(pool: PgPool) {
    let (artist_id, album_id, track_id) = seed_library(&pool).await;
    let server = mb_with_all().await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, v) = get_json(app, "/api/search?q=radiohead").await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["query"], "radiohead");
    assert!(v["errors"].as_array().unwrap().is_empty(), "{v}");

    let a = &v["artists"];
    assert_eq!(a.as_array().unwrap().len(), 2);
    assert_eq!(a[0]["name"], "Radiohead");
    assert_eq!(a[0]["country"], "GB");
    assert_eq!(a[0]["score"], 100);
    assert_eq!(a[0]["library_id"], artist_id);
    assert!(a[1]["library_id"].is_null(), "не добавленный артист → null");

    let g = &v["albums"];
    assert_eq!(g[0]["title"], "OK Computer");
    assert_eq!(g[0]["artist_name"], "Radiohead");
    assert_eq!(g[0]["year"], 1997);
    assert_eq!(g[0]["library_id"], album_id);
    assert_eq!(
        g[0]["cover_url"],
        format!("https://coverartarchive.org/release-group/{OK_COMPUTER}/front-250")
    );
    assert!(g[1]["library_id"].is_null());

    let t = &v["tracks"];
    assert_eq!(t[0]["title"], "Paranoid Android");
    assert_eq!(t[0]["album_mbid"], OK_COMPUTER);
    assert_eq!(t[0]["album_title"], "OK Computer");
    assert_eq!(t[0]["duration_ms"], 387_000);
    assert_eq!(t[0]["library_id"], track_id);
    assert_eq!(t[0]["status"], "found");
    assert!(t[1]["library_id"].is_null() && t[1]["status"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_not_in_library_is_not_marked(pool: PgPool) {
    let (_, _, track_id) = seed_library(&pool).await;
    sqlx::query("UPDATE tracks SET in_library = FALSE WHERE id = $1")
        .bind(track_id)
        .execute(&pool)
        .await
        .unwrap();
    let server = mb_with_all().await;
    let (_, v) = get_json(
        router(state_with_mb(pool, mb_client(&server))),
        "/api/search?q=paranoid",
    )
    .await;
    assert!(v["tracks"][0]["library_id"].is_null());
    assert!(v["tracks"][0]["status"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn one_failing_mb_request_still_returns_the_rest(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release-group"))
        .respond_with(json("search_release_group"))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/recording"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;
    let (status, v) = get_json(
        router(state_with_mb(pool, mb_client(&server))),
        "/api/search?q=radiohead",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(v["artists"].as_array().unwrap().len(), 2);
    assert_eq!(v["albums"].as_array().unwrap().len(), 2);
    assert!(v["tracks"].as_array().unwrap().is_empty());
    let errors = v["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1);
    assert!(
        errors[0].as_str().unwrap().starts_with("tracks:"),
        "{errors:?}"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn slow_request_times_out_but_others_are_returned(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release-group"))
        .respond_with(json("search_release_group").set_delay(Duration::from_secs(5)))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/recording"))
        .respond_with(json("search_recording"))
        .mount(&server)
        .await;
    let mut state = state_with_mb(pool, mb_client(&server));
    state.search_timeout = Duration::from_millis(400);
    let started = std::time::Instant::now();
    let (status, v) = get_json(router(state), "/api/search?q=radiohead").await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(status, 200);
    assert_eq!(v["artists"].as_array().unwrap().len(), 2);
    assert!(v["albums"].as_array().unwrap().is_empty());
    assert_eq!(v["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(v["errors"], serde_json::json!(["albums: timeout"]));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn validation(pool: PgPool) {
    let server = MockServer::start().await;
    let app = || router(state_with_mb(pool.clone(), mb_client(&server)));
    let long = "a".repeat(201);
    for (uri, code) in [
        ("/api/search".to_string(), "bad_query"),
        ("/api/search?q=".to_string(), "bad_query"),
        ("/api/search?q=%20%20".to_string(), "bad_query"),
        (format!("/api/search?q={long}"), "bad_query"),
        ("/api/search?q=abc&limit=0".to_string(), "bad_limit"),
        ("/api/search?q=abc&limit=26".to_string(), "bad_limit"),
        (
            "/api/search?q=abc&types=artist,bogus".to_string(),
            "bad_types",
        ),
    ] {
        let (status, v) = get_json(app(), &uri).await;
        assert_eq!(status, 400, "{uri}");
        assert_eq!(v["error"]["code"], code, "{uri}: {v}");
    }
    // граничные значения допустимы
    let (status, _) = get_json(
        app(),
        &format!("/api/search?q={}&limit=25", "a".repeat(200)),
    )
    .await;
    assert_eq!(status, 200);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn types_and_short_query_limit_mb_requests(pool: PgPool) {
    let server = mb_with_all().await;
    let app = || router(state_with_mb(pool.clone(), mb_client(&server)));

    let (_, v) = get_json(app(), "/api/search?q=radiohead&types=artist&limit=3").await;
    assert_eq!(v["artists"].as_array().unwrap().len(), 2);
    assert!(
        v["albums"].as_array().unwrap().is_empty() && v["tracks"].as_array().unwrap().is_empty()
    );
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].url.query().unwrap().contains("limit=3"));

    // короче 3 символов — только артисты, даже если запрошены все типы
    server.reset().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    let (status, v) = get_json(app(), "/api/search?q=ra&types=artist,album,track").await;
    assert_eq!(status, 200);
    assert_eq!(v["artists"].as_array().unwrap().len(), 2);
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].url.path(), "/ws/2/artist");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn openapi_endpoint_and_cli(pool: PgPool) {
    let (status, v) = get_json(router(common::state(pool)), "/api/openapi.json").await;
    assert_eq!(status, 200);
    let paths = v["paths"].as_object().unwrap();
    for p in ["/api/search", "/api/health", "/api/ws"] {
        assert!(
            paths.contains_key(p),
            "{p} отсутствует: {:?}",
            paths.keys().collect::<Vec<_>>()
        );
    }
    assert!(v["components"]["schemas"]["SearchResponse"].is_object());
    assert!(v["components"]["schemas"]["TrackStatus"].is_object());
    // значения enum в спецификации совпадают с теми, что реально идут по сети
    assert_eq!(
        v["components"]["schemas"]["TrackStatus"]["enum"],
        serde_json::json!(["adding", "found", "not_found", "ready"])
    );

    // --print-openapi работает без БД и окружения
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_nimbus"))
        .arg("--print-openapi")
        .env_remove("DATABASE_URL")
        .output()
        .unwrap();
    assert!(out.status.success());
    let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(printed["paths"]["/api/search"].is_object());
    assert_eq!(printed["info"]["title"], "Nimbus API");
}
