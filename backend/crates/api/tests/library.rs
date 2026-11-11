mod common;

use common::{delete, get_json, mb_client, post_json, router, state_with_mb};
use nimbus_api::AppState;
use nimbus_core::events::{Entity, Event};
use nimbus_core::jobs::Job;
use nimbus_core::model::{NewArtist, TrackStatus};
use nimbus_db::repo::{albums, artists, jobs, tracks};
use nimbus_worker::handlers::ImportArtistHandler;
use nimbus_worker::{JobCtx, JobHandler};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const RADIOHEAD: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OK_COMPUTER: &str = "b1392450-e666-3926-a536-22c65f834433";
const EP_RG: &str = "d0000000-0000-4000-8000-0000000000e1";
const R_OKC: &str = "c0000000-0000-4000-8000-000000000002";
const R_EP: &str = "c0000000-0000-4000-8000-0000000000e1";
const PARANOID: &str = "f0000000-0000-4000-8000-000000000002";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/../musicbrainz/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn json_body(name: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(fixture(name), "application/json")
}

async fn mount(server: &MockServer, p: String, q: Option<(&str, &str)>, body: &str) {
    let mut m = Mock::given(method("GET")).and(path(p));
    if let Some((k, v)) = q {
        m = m.and(query_param(k, v));
    }
    m.respond_with(json_body(body)).mount(server).await;
}

/// MB с OK Computer, EP, артистом Radiohead и записью Paranoid Android.
async fn mb_server() -> MockServer {
    let s = MockServer::start().await;
    mount(&s, format!("/ws/2/artist/{RADIOHEAD}"), None, "artist").await;
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
    mount(
        &s,
        "/ws/2/release".into(),
        Some(("release-group", EP_RG)),
        "releases_browse_ep",
    )
    .await;
    mount(&s, format!("/ws/2/release/{R_OKC}"), None, "release").await;
    mount(&s, format!("/ws/2/release/{R_EP}"), None, "release_ep").await;
    mount(
        &s,
        format!("/ws/2/recording/{PARANOID}"),
        None,
        "recording_lookup",
    )
    .await;
    mount(
        &s,
        "/ws/2/release-group".into(),
        Some(("artist", RADIOHEAD)),
        "artist_release_groups_import",
    )
    .await;
    s
}

fn app(pool: &PgPool, server: &MockServer) -> (AppState, axum::Router) {
    let state = state_with_mb(pool.clone(), mb_client(server));
    let router = router(state.clone());
    (state, router)
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<Event>) -> Vec<Event> {
    let mut out = vec![];
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn post_album_creates_tracks_job_and_events(pool: PgPool) {
    let server = mb_server().await;
    let (state, router) = app(&pool, &server);
    let mut rx = state.events.subscribe();

    let (status, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["type"], "album");
    assert_eq!(body["status"], "added");
    let album_id = body["id"].as_i64().unwrap();

    let album = albums::get(&pool, album_id).await.unwrap().unwrap();
    assert!(album.in_library && album.added_at.is_some());
    assert_eq!(album.title, "OK Computer");
    assert_eq!(album.year, Some(1997));
    assert_eq!(album.mbid_release, Some(Uuid::parse_str(R_OKC).unwrap()));
    assert_eq!(
        album.cover_url.as_deref(),
        Some(format!("https://coverartarchive.org/release-group/{OK_COMPUTER}/front-500").as_str())
    );
    let ts = tracks::list_by_album(&pool, album_id).await.unwrap();
    assert_eq!(ts.len(), 4);
    assert!(ts.iter().all(|t| t.in_library
        && t.status == TrackStatus::Adding
        && t.artist_id == album.artist_id));
    assert_eq!((ts[3].disc_no, ts[3].position), (2, 1));
    let artist = artists::get(&pool, album.artist_id).await.unwrap().unwrap();
    assert!(artist.in_library);

    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].job().unwrap(), Job::DiscoverAlbum { album_id });

    let events = drain(&mut rx);
    assert!(
        events.contains(&Event::LibraryChanged {
            entity: Entity::Album,
            id: album_id
        }),
        "{events:?}"
    );
    assert!(events.contains(&Event::LibraryChanged {
        entity: Entity::Artist,
        id: album.artist_id
    }));

    // повторный POST: 200, без новых задач и без повторных обращений к MB за треклистом
    let before = server.received_requests().await.unwrap().len();
    let (status, body) = post_json(
        router,
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "exists");
    assert_eq!(body["id"], album_id);
    assert_eq!(count(&pool, "SELECT count(*) FROM jobs").await, 1);
    assert_eq!(server.received_requests().await.unwrap().len(), before);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_detail_has_status_counts_and_ordered_tracks(pool: PgPool) {
    let server = mb_server().await;
    let (_, router) = app(&pool, &server);
    let (_, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    let album_id = body["id"].as_i64().unwrap();
    let ts = tracks::list_by_album(&pool, album_id).await.unwrap();
    tracks::set_status(&pool, ts[0].id, TrackStatus::Found, None)
        .await
        .unwrap();
    tracks::set_status(&pool, ts[1].id, TrackStatus::Ready, None)
        .await
        .unwrap();
    tracks::set_status(
        &pool,
        ts[2].id,
        TrackStatus::NotFound,
        Some(nimbus_core::model::NotFoundReason::NoMatch),
    )
    .await
    .unwrap();

    let (status, v) = get_json(router.clone(), &format!("/api/albums/{album_id}")).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["album"]["title"], "OK Computer");
    assert_eq!(v["album"]["track_count"], 4);
    assert_eq!(
        v["album"]["status_counts"],
        json!({"adding": 1, "found": 1, "not_found": 1, "ready": 1})
    );
    assert_eq!(v["artist"]["name"], "Radiohead");
    assert_eq!(v["artist"]["album_count"], 1);
    assert_eq!(v["artist"]["track_count"], 4);
    let titles: Vec<_> = v["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        titles,
        [
            "Airbag",
            "Paranoid Android",
            "Subterranean Homesick Alien",
            "Lift"
        ]
    );
    assert_eq!(v["tracks"][2]["status"], "not_found");
    assert_eq!(v["tracks"][2]["status_reason"], "no_match");
    assert_eq!(v["tracks"][0]["in_library"], true);
    assert_eq!(v["tracks"][0]["artist_name"], "Radiohead");

    // отдельный трек и страница артиста
    let tid = ts[0].id;
    let (status, t) = get_json(router.clone(), &format!("/api/tracks/{tid}")).await;
    assert_eq!(status, 200);
    assert_eq!(t["album_title"], "OK Computer");
    assert_eq!(get_json(router.clone(), "/api/tracks/99999").await.0, 404);
    let artist_id = v["artist"]["id"].as_i64().unwrap();
    let (status, a) = get_json(router.clone(), &format!("/api/artists/{artist_id}")).await;
    assert_eq!(status, 200);
    assert_eq!(a["artist"]["name"], "Radiohead");
    assert_eq!(a["albums"].as_array().unwrap().len(), 1);
    assert_eq!(get_json(router.clone(), "/api/artists/99999").await.0, 404);
    assert_eq!(get_json(router, "/api/albums/99999").await.0, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn post_track_adds_only_that_track(pool: PgPool) {
    let server = mb_server().await;
    let (_, router) = app(&pool, &server);
    // без album_mbid альбом определяется по записи в MusicBrainz
    let (status, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "track", "mbid": PARANOID}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["type"], "track");
    let track_id = body["id"].as_i64().unwrap();

    let track = tracks::get(&pool, track_id).await.unwrap().unwrap();
    assert_eq!(track.title, "Paranoid Android");
    assert!(track.in_library);
    let album = albums::get(&pool, track.album_id).await.unwrap().unwrap();
    assert!(!album.in_library, "альбом целиком не добавляется");
    assert_eq!(count(&pool, "SELECT count(*) FROM tracks").await, 4);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE in_library").await,
        1
    );
    assert!(
        artists::get(&pool, track.artist_id)
            .await
            .unwrap()
            .unwrap()
            .in_library
    );
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(
        queued[0].job().unwrap(),
        Job::DiscoverAlbum { album_id: album.id }
    );

    // повтор → 200
    let (status, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "exists");

    // альбом с одним добавленным треком виден на странице артиста и в списке треков, но не в списке альбомов
    let (_, v) = get_json(router.clone(), &format!("/api/artists/{}", track.artist_id)).await;
    assert_eq!(v["albums"].as_array().unwrap().len(), 1);
    assert_eq!(v["albums"][0]["in_library"], false);
    assert_eq!(v["artist"]["track_count"], 1);
    let (_, l) = get_json(router.clone(), "/api/library/albums").await;
    assert!(l["items"].as_array().unwrap().is_empty());
    let (_, l) = get_json(router, "/api/library/tracks").await;
    assert_eq!(l["items"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn post_track_with_album_mbid_and_unknown_recording(pool: PgPool) {
    let server = mb_server().await;
    let (_, router) = app(&pool, &server);
    let (status, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "track", "mbid": PARANOID, "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201, "{body}");

    let (status, body) = post_json(
        router,
        "/api/library",
        json!({"type": "track", "mbid": "f0000000-0000-4000-8000-0000000000aa", "album_mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 422);
    assert_eq!(body["error"]["code"], "recording_not_in_release");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn post_artist_is_accepted_and_import_job_adds_discography(pool: PgPool) {
    let server = mb_server().await;
    let (state, router) = app(&pool, &server);
    let (status, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "artist", "mbid": RADIOHEAD}),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["status"], "importing");
    let artist_id = body["id"].as_i64().unwrap();
    assert!(
        artists::get(&pool, artist_id)
            .await
            .unwrap()
            .unwrap()
            .in_library
    );
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    let job = queued[0].job().unwrap();
    assert_eq!(job, Job::ImportArtist { artist_id });
    assert_eq!(
        albums::list_by_artist(&pool, artist_id)
            .await
            .unwrap()
            .len(),
        0,
        "ответ до импорта"
    );

    // повтор → 200, вторая задача не ставится
    let (status, _) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "artist", "mbid": RADIOHEAD}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(count(&pool, "SELECT count(*) FROM jobs").await, 1);

    // выполняем задачу вручную
    let mut rx = state.events.subscribe();
    let ctx = JobCtx {
        db: pool.clone(),
        events: state.events.clone(),
        mb: mb_client(&server),
    };
    ImportArtistHandler.handle(job, &ctx).await.unwrap();

    let titles: Vec<String> = albums::list_by_artist(&pool, artist_id)
        .await
        .unwrap()
        .into_iter()
        .map(|a| a.title)
        .collect();
    assert_eq!(
        titles,
        ["OK Computer", "Airbag EP"],
        "без Live, Compilation и чужих совместных релизов"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM albums WHERE in_library").await,
        2
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM tracks WHERE in_library AND status = 'adding'"
        )
        .await,
        6
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM artists").await,
        1,
        "чужой артист не создан"
    );
    let kinds: Vec<String> = jobs::list(&pool, Some("queued"), 10)
        .await
        .unwrap()
        .into_iter()
        .map(|j| j.kind)
        .collect();
    assert!(kinds.contains(&"discover_artist".to_string()), "{kinds:?}");
    assert!(!kinds.contains(&"discover_album".to_string()), "{kinds:?}");
    let album_events = drain(&mut rx)
        .into_iter()
        .filter(|e| {
            matches!(
                e,
                Event::LibraryChanged {
                    entity: Entity::Album,
                    ..
                }
            )
        })
        .count();
    assert_eq!(album_events, 2);

    let (_, l) = get_json(router.clone(), "/api/library/artists").await;
    assert_eq!(l["items"][0]["album_count"], 2);
    assert_eq!(l["items"][0]["track_count"], 6);

    // повторный импорт идемпотентен
    ImportArtistHandler
        .handle(Job::ImportArtist { artist_id }, &ctx)
        .await
        .unwrap();
    assert_eq!(count(&pool, "SELECT count(*) FROM tracks").await, 6);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn delete_clears_in_library_but_keeps_rows(pool: PgPool) {
    let server = mb_server().await;
    let (state, router) = app(&pool, &server);
    let (_, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    let album_id = body["id"].as_i64().unwrap();
    let mut rx = state.events.subscribe();

    let (status, _) = delete(router.clone(), &format!("/api/library/album/{album_id}")).await;
    assert_eq!(status, 204);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks").await,
        4,
        "строки не удаляются"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE in_library").await,
        0
    );
    assert!(
        !albums::get(&pool, album_id)
            .await
            .unwrap()
            .unwrap()
            .in_library
    );
    assert!(drain(&mut rx).contains(&Event::LibraryChanged {
        entity: Entity::Album,
        id: album_id
    }));
    let (_, l) = get_json(router.clone(), "/api/library/albums").await;
    assert!(l["items"].as_array().unwrap().is_empty());
    // метаданные доступны
    assert_eq!(
        get_json(router.clone(), &format!("/api/albums/{album_id}"))
            .await
            .0,
        200
    );

    // повторное добавление возвращает в библиотеку без обращения к MB
    let before = server.received_requests().await.unwrap().len();
    let (status, _) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(server.received_requests().await.unwrap().len(), before);

    // артист: снимает со всех альбомов и треков
    let artist_id = albums::get(&pool, album_id)
        .await
        .unwrap()
        .unwrap()
        .artist_id;
    assert_eq!(
        delete(router.clone(), &format!("/api/library/artist/{artist_id}"))
            .await
            .0,
        204
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM albums WHERE in_library").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE in_library").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM artists WHERE in_library").await,
        0
    );

    // трек
    let (_, b) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "track", "mbid": PARANOID}),
    )
    .await;
    let tid = b["id"].as_i64().unwrap();
    assert_eq!(
        delete(router.clone(), &format!("/api/library/track/{tid}"))
            .await
            .0,
        204
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE in_library").await,
        0
    );

    // ошибки
    let (status, v) = delete(router.clone(), "/api/library/bogus/1").await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (400, Some("bad_type"))
    );
    assert_eq!(
        delete(router.clone(), "/api/library/album/99999").await.0,
        404
    );
    assert_eq!(delete(router, "/api/library/artist/99999").await.0, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn re_adding_resets_not_found_tracks(pool: PgPool) {
    let server = mb_server().await;
    let (_, router) = app(&pool, &server);
    let (_, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    let album_id = body["id"].as_i64().unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        tracks::set_status(
            &pool,
            t.id,
            TrackStatus::NotFound,
            Some(nimbus_core::model::NotFoundReason::NoTorrents),
        )
        .await
        .unwrap();
    }
    delete(router.clone(), &format!("/api/library/album/{album_id}")).await;
    let (status, _) = post_json(
        router,
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(status, 201);
    let ts = tracks::list_by_album(&pool, album_id).await.unwrap();
    assert!(ts
        .iter()
        .all(|t| t.status == TrackStatus::Adding && t.status_reason.is_none()));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn error_mapping(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/release-group/{OK_COMPUTER}")))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let (_, router) = app(&pool, &server);

    let (status, v) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (404, Some("mb_not_found"))
    );
    let (status, v) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "artist", "mbid": RADIOHEAD}),
    )
    .await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (503, Some("mb_unavailable"))
    );

    for body in [
        json!({"type": "bogus", "mbid": RADIOHEAD}),
        json!({"type": "artist", "mbid": "not-a-uuid"}),
        json!({"type": "artist"}),
        json!({}),
    ] {
        let (status, v) = post_json(router.clone(), "/api/library", body.clone()).await;
        assert_eq!(
            (status, v["error"]["code"].as_str()),
            (400, Some("bad_request")),
            "{body}"
        );
    }
    assert_eq!(count(&pool, "SELECT count(*) FROM jobs").await, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn library_lists_paginate_by_added_at_desc(pool: PgPool) {
    let server = MockServer::start().await;
    let (_, router) = app(&pool, &server);
    let mut ids = vec![];
    for i in 0..5 {
        let a = artists::upsert_by_mbid(
            &pool,
            &NewArtist {
                mbid: Uuid::new_v4(),
                name: format!("Artist {i}"),
                sort_name: None,
                disambiguation: None,
            },
        )
        .await
        .unwrap();
        artists::set_in_library(&pool, a.id, true).await.unwrap();
        ids.push(a.id);
    }
    // не в библиотеке — не попадает
    artists::upsert_by_mbid(
        &pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Hidden".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();

    let mut seen = vec![];
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let uri = match &cursor {
            Some(c) => format!(
                "/api/library/artists?limit=2&cursor={}",
                c.replace('|', "%7C").replace('+', "%2B")
            ),
            None => "/api/library/artists?limit=2".to_string(),
        };
        let (status, v) = get_json(router.clone(), &uri).await;
        assert_eq!(status, 200, "{v}");
        seen.extend(
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["id"].as_i64().unwrap()),
        );
        pages += 1;
        match v["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
        assert!(pages < 10);
    }
    ids.reverse();
    assert_eq!(
        seen, ids,
        "порядок added_at DESC, id DESC без дублей и пропусков"
    );
    assert_eq!(pages, 3);

    for uri in [
        "/api/library/artists?cursor=garbage",
        "/api/library/artists?limit=0",
        "/api/library/albums?limit=201",
        "/api/library/tracks?status=bogus",
    ] {
        assert_eq!(get_json(router.clone(), uri).await.0, 400, "{uri}");
    }
    let (status, v) = get_json(router.clone(), "/api/library/tracks?status=found").await;
    assert_eq!((status, v["items"].as_array().unwrap().len()), (200, 0));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_list_status_filter(pool: PgPool) {
    let server = mb_server().await;
    let (_, router) = app(&pool, &server);
    let (_, body) = post_json(
        router.clone(),
        "/api/library",
        json!({"type": "album", "mbid": OK_COMPUTER}),
    )
    .await;
    let ts = tracks::list_by_album(&pool, body["id"].as_i64().unwrap())
        .await
        .unwrap();
    tracks::set_status(&pool, ts[1].id, TrackStatus::Found, None)
        .await
        .unwrap();
    let (_, v) = get_json(router.clone(), "/api/library/tracks?status=found").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["items"][0]["title"], "Paranoid Android");
    // несколько статусов через запятую
    let (_, v) = get_json(router.clone(), "/api/library/tracks?status=found,ready").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    let (_, v) = get_json(router.clone(), "/api/library/tracks?status=found,%20adding").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 4);
    assert_eq!(
        get_json(router.clone(), "/api/library/tracks?status=found,bogus")
            .await
            .0,
        400
    );
    let (_, v) = get_json(router, "/api/library/tracks?status=adding&limit=2").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    assert!(v["next_cursor"].is_string());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn openapi_lists_library_endpoints(pool: PgPool) {
    let (status, v) = get_json(router(common::state(pool)), "/api/openapi.json").await;
    assert_eq!(status, 200);
    let paths = v["paths"].as_object().unwrap();
    for p in [
        "/api/library",
        "/api/library/{type}/{id}",
        "/api/library/artists",
        "/api/library/albums",
        "/api/library/tracks",
        "/api/artists/{id}",
        "/api/albums/{id}",
        "/api/tracks/{id}",
    ] {
        assert!(paths.contains_key(p), "{p} отсутствует");
    }
    assert!(v["components"]["schemas"]["AlbumDetailDto"].is_object());
}
