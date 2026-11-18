// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{get_json, mb_client, post_json, router, state, state_with_mb};
use serde_json::json;
use sqlx::PgPool;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const RADIOHEAD: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OK_COMPUTER: &str = "b1392450-e666-3926-a536-22c65f834433";
const R_OKC: &str = "c0000000-0000-4000-8000-000000000002";
const PARANOID: &str = "f0000000-0000-4000-8000-000000000002";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/../musicbrainz/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

async fn mount(server: &MockServer, p: String, q: Option<(&str, &str)>, body: &str) {
    let mut m = Mock::given(method("GET")).and(path(p));
    if let Some((k, v)) = q {
        m = m.and(query_param(k, v));
    }
    m.respond_with(ResponseTemplate::new(200).set_body_raw(fixture(body), "application/json"))
        .mount(server)
        .await;
}

/// MB с артистом Radiohead (дискография из пяти групп) и альбомом OK Computer.
async fn mb_server() -> MockServer {
    let s = MockServer::start().await;
    mount(&s, format!("/ws/2/artist/{RADIOHEAD}"), None, "artist").await;
    mount(
        &s,
        "/ws/2/release-group".into(),
        Some(("artist", RADIOHEAD)),
        "artist_release_groups_import",
    )
    .await;
    mount(
        &s,
        format!("/ws/2/release-group/{OK_COMPUTER}"),
        None,
        "release_group",
    )
    .await;
    mount(
        &s,
        "/ws/2/release".into(),
        Some(("release-group", OK_COMPUTER)),
        "releases_browse",
    )
    .await;
    mount(&s, format!("/ws/2/release/{R_OKC}"), None, "release").await;
    s
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_lists_own_albums_newest_first(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, v) = get_json(app, &format!("/api/catalog/artists/{RADIOHEAD}")).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["artist"]["name"], "Radiohead");
    assert_eq!(v["artist"]["country"], "GB");
    assert!(v["artist"]["library_id"].is_null());
    let titles: Vec<&str> = v["albums"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["title"].as_str().unwrap())
        .collect();
    // «Collab Album» — первым указан другой артист: не его дискография.
    assert_eq!(
        titles,
        [
            "Radiohead: The Best Of",
            "I Might Be Wrong",
            "Airbag EP",
            "OK Computer"
        ]
    );
    let okc = &v["albums"][3];
    assert_eq!(okc["mbid"], OK_COMPUTER);
    assert_eq!(okc["year"], 1997);
    assert_eq!(okc["artist_name"], "Radiohead");
    assert_eq!(
        okc["cover_url"],
        format!("https://coverartarchive.org/release-group/{OK_COMPUTER}/front-250")
    );
    assert!(okc["library_id"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_returns_tracklist_of_canonical_release(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, v) = get_json(app, &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["album"]["title"], "OK Computer");
    assert_eq!(v["album"]["artist_mbid"], RADIOHEAD);
    assert!(v["album"]["library_id"].is_null());
    let tracks = v["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 4);
    assert_eq!(tracks[1]["title"], "Paranoid Android");
    assert_eq!(tracks[1]["mbid"], PARANOID);
    assert_eq!(tracks[1]["position"], 2);
    assert_eq!(tracks[3]["disc_no"], 2);
    assert_eq!(tracks[0]["duration_ms"], 284_000);
    assert!(tracks[0]["library_id"].is_null() && tracks[0]["status"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn library_ids_are_marked_after_add(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, added) = post_json(
        app.clone(),
        "/api/library",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201, "{added}");

    let (_, album) = get_json(app.clone(), &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    // Добавлен только трек: альбом целиком в библиотеке не числится, а трек — да.
    assert_eq!(album["tracks"][1]["library_id"], added["id"]);
    assert_eq!(album["tracks"][1]["status"], "adding");
    assert!(album["tracks"][0]["library_id"].is_null());

    let (_, artist) = get_json(app, &format!("/api/catalog/artists/{RADIOHEAD}")).await;
    assert!(artist["artist"]["library_id"].is_i64(), "{artist}");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn bad_mbid_is_400(pool: PgPool) {
    let app = router(state(pool));
    for uri in ["/api/catalog/artists/nope", "/api/catalog/albums/nope"] {
        let (status, v) = get_json(app.clone(), uri).await;
        assert_eq!(status, 400, "{uri}: {v}");
        assert_eq!(v["error"]["code"], "bad_mbid");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unknown_mbid_is_404(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, v) = get_json(app, &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    assert_eq!(status, 404, "{v}");
    assert_eq!(v["error"]["code"], "mb_not_found");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn musicbrainz_down_is_503(pool: PgPool) {
    // `state` смотрит на закрытый порт: любой запрос к MB падает.
    let app = router(state(pool));
    let (status, v) = get_json(app, &format!("/api/catalog/artists/{RADIOHEAD}")).await;
    assert_eq!(status, 503, "{v}");
    assert_eq!(v["error"]["code"], "mb_unavailable");
}

async fn track_row(pool: &PgPool, id: i64) -> (bool, bool, String) {
    sqlx::query_as("SELECT in_library, play_requested, status::text FROM tracks WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn discover_jobs(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind = 'discover_album'")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_track_searches_a_source_without_adding_to_library(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool.clone(), mb_client(&server)));
    let (status, v) = post_json(
        app.clone(),
        "/api/play",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    let ids = v["track_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 1);
    let id = ids[0].as_i64().unwrap();
    assert_eq!(
        track_row(&pool, id).await,
        (false, true, "adding".to_string())
    );
    assert_eq!(discover_jobs(&pool).await, 1);
    // В библиотеке ничего не появилось: ни трек, ни альбом, ни артист.
    let in_library: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM tracks WHERE in_library) + (SELECT count(*) FROM albums WHERE in_library)
              + (SELECT count(*) FROM artists WHERE in_library)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(in_library, 0);
    let (_, album) = get_json(app.clone(), &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    assert!(album["tracks"][1]["library_id"].is_null(), "{album}");

    // Повтор — тот же трек, без второй задачи; «добавить» потом — сразу в библиотеку, метаданные уже есть.
    let (_, again) = post_json(
        app.clone(),
        "/api/play",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(again["track_ids"][0], id);
    assert_eq!(discover_jobs(&pool).await, 1);
    let (status, added) = post_json(
        app,
        "/api/library",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201, "{added}");
    assert_eq!(added["id"], id);
    assert!(track_row(&pool, id).await.0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_returns_statuses_after_marking(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool.clone(), mb_client(&server)));
    let body = json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER});
    let (_, first) = post_json(app.clone(), "/api/play", body.clone()).await;
    let id = first["track_ids"][0].as_i64().unwrap();
    assert_eq!(first["tracks"], json!([{"id": id, "status": "adding"}]));

    // Поиск закончился без источника: повторное «сыграть» сбрасывает в `adding` — и отвечает именно так.
    sqlx::query("UPDATE tracks SET status = 'not_found' WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (_, again) = post_json(app.clone(), "/api/play", body.clone()).await;
    assert_eq!(again["tracks"], json!([{"id": id, "status": "adding"}]));

    // Источник уже есть: статус остаётся `found`.
    sqlx::query("UPDATE tracks SET status = 'found' WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (_, found) = post_json(app, "/api/play", body).await;
    assert_eq!(found["tracks"], json!([{"id": id, "status": "found"}]));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_times_out_as_mb_unavailable(pool: PgPool) {
    // MusicBrainz отвечает дольше таймаута: 503, и ничего не помечено к воспроизведению (поиск не поставлен).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(fixture("release_group"), "application/json")
                .set_delay(std::time::Duration::from_secs(5)),
        )
        .mount(&server)
        .await;
    let mut st = state_with_mb(pool.clone(), mb_client(&server));
    st.catalog_timeout = std::time::Duration::from_millis(300);
    let started = std::time::Instant::now();
    for body in [
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
        json!({"type": "album", "mbid": OK_COMPUTER}),
    ] {
        let (status, v) = post_json(router(st.clone()), "/api/play", body).await;
        assert_eq!(status, 503, "{v}");
        assert_eq!(v["error"]["code"], "mb_unavailable");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    let marked: i64 = sqlx::query_scalar("SELECT count(*) FROM tracks WHERE play_requested")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(marked, 0);
    assert_eq!(discover_jobs(&pool).await, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_album_requests_every_track_in_tracklist_order(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool.clone(), mb_client(&server)));
    let (status, v) = post_json(
        app,
        "/api/play",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    let ids: Vec<i64> = v["track_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_i64().unwrap())
        .collect();
    assert_eq!(ids.len(), 4);
    let titles: Vec<String> = sqlx::query_scalar(
        "SELECT title FROM tracks WHERE id = ANY($1) AND play_requested AND NOT in_library
         ORDER BY array_position($1, id)",
    )
    .bind(&ids)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(titles[0], "Airbag");
    assert_eq!(titles.len(), 4);
    assert!(v["album_id"].is_i64());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_errors(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool, mb_client(&server)));
    let (status, v) = post_json(
        app.clone(),
        "/api/play",
        json!({"type": "artist", "mbid": RADIOHEAD}),
    )
    .await;
    assert_eq!(status, 400, "{v}");
    let (status, v) = post_json(
        app,
        "/api/play",
        json!({"type": "track", "mbid": RADIOHEAD, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 422, "{v}");
    assert_eq!(v["error"]["code"], "recording_not_in_release");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn opened_album_is_kept_in_db_and_reopens_without_musicbrainz(pool: PgPool) {
    let server = mb_server().await;
    let app = router(state_with_mb(pool.clone(), mb_client(&server)));
    let (status, _) = get_json(app.clone(), &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    assert_eq!(status, 200);
    // Альбом, треки и артист — в БД, но не в библиотеке.
    let (albums, tracks, in_library): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM albums), (SELECT count(*) FROM tracks),
                (SELECT count(*) FROM tracks WHERE in_library) + (SELECT count(*) FROM albums WHERE in_library)
                  + (SELECT count(*) FROM artists WHERE in_library)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((albums, tracks, in_library), (1, 4, 0));
    // MusicBrainz пропал — альбом всё равно открывается (из БД), «сыграть» тоже не ходит в MusicBrainz.
    server.reset().await;
    let (status, v) = get_json(app.clone(), &format!("/api/catalog/albums/{OK_COMPUTER}")).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["tracks"][1]["title"], "Paranoid Android");
    assert_eq!(v["album"]["artist_name"], "Radiohead");
    let (status, v) = post_json(
        app,
        "/api/play",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    assert!(server.received_requests().await.unwrap().is_empty());
}
