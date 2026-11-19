// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nimbus_musicbrainz::{cover_url, MbClient, MbConfig, MbError, MbLimits, Priority};
use sqlx::PgPool;
use uuid::Uuid;
use wiremock::matchers::{header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

const RADIOHEAD: &str = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OK_COMPUTER: &str = "b1392450-e666-3926-a536-22c65f834433";
const UA: &str = "NimbusTest/0.1 ( https://example.org/test )";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn json(name: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(fixture(name), "application/json")
}

fn uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).unwrap()
}

fn cfg(server: &MockServer) -> MbConfig {
    let mut c = MbConfig::new(UA);
    c.base = format!("{}/ws/2/", server.uri()).parse().unwrap();
    c.limits = MbLimits::unlimited(8);
    c.retry_delay = Duration::from_millis(10);
    c
}

fn client(server: &MockServer) -> MbClient {
    MbClient::with_config(cfg(server), None).unwrap()
}

#[tokio::test]
async fn search_artists_parses_and_sends_ua_and_fmt() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ws/2/artist"))
        .and(query_param("fmt", "json"))
        .and(query_param("query", "radiohead*"))
        .and(query_param("limit", "5"))
        .and(header("user-agent", UA))
        .respond_with(json("search_artist"))
        .expect(1)
        .mount(&server)
        .await;
    let hits = client(&server)
        .search_artists("radiohead", 5)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].mbid, uuid(RADIOHEAD));
    assert_eq!(hits[0].name, "Radiohead");
    assert_eq!(hits[0].country.as_deref(), Some("GB"));
    assert_eq!(hits[0].disambiguation, None, "пустая строка → None");
    assert_eq!(hits[0].score, 100);
    assert_eq!(hits[1].disambiguation.as_deref(), Some("UK DJ"));
    assert_eq!(hits[1].score, 62);
}

#[tokio::test]
async fn empty_query_makes_no_request() {
    let server = MockServer::start().await;
    let c = client(&server);
    assert!(c.search_artists("   ", 5).await.unwrap().is_empty());
    assert!(c.search_release_groups("", 5).await.unwrap().is_empty());
    assert!(c.search_recordings("", 5).await.unwrap().is_empty());
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn search_release_groups_parses() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/release-group"))
        .respond_with(json("search_release_group"))
        .mount(&server)
        .await;
    let hits = client(&server)
        .search_release_groups("ok computer", 5)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
    let h = &hits[0];
    assert_eq!(h.mbid, uuid(OK_COMPUTER));
    assert_eq!(h.title, "OK Computer");
    assert_eq!(h.artist_mbid, uuid(RADIOHEAD));
    assert_eq!(h.artist_name, "Radiohead");
    assert_eq!(h.primary_type.as_deref(), Some("Album"));
    assert!(h.secondary_types.is_empty());
    assert_eq!(h.year, Some(1997));
    assert_eq!(hits[1].secondary_types, vec!["Compilation"]);
    assert_eq!(hits[1].year, Some(2017));
}

#[tokio::test]
async fn search_recordings_picks_album_release_group() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/recording"))
        .respond_with(json("search_recording"))
        .mount(&server)
        .await;
    let hits = client(&server)
        .search_recordings("paranoid android", 5)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
    let h = &hits[0];
    assert_eq!(h.title, "Paranoid Android");
    assert_eq!(h.artist_mbid, uuid(RADIOHEAD));
    assert_eq!(h.duration_ms, Some(387_000));
    // из Single / Compilation / Album выбирается обычный Album
    assert_eq!(h.release_group_mbid, Some(uuid(OK_COMPUTER)));
    assert_eq!(h.album_title.as_deref(), Some("OK Computer"));
    // у второй записи только EP
    assert_eq!(
        hits[1].album_title.as_deref(),
        Some("Airbag / How Am I Driving?")
    );
    assert_eq!(hits[1].duration_ms, None);
}

#[tokio::test]
async fn lookups_parse() {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .mount(&server)
        .await;
    Mock::given(path(format!("/ws/2/release-group/{OK_COMPUTER}")))
        .and(query_param("inc", "artist-credits"))
        .respond_with(json("release_group"))
        .mount(&server)
        .await;
    let c = client(&server);
    let a = c.artist(uuid(RADIOHEAD)).await.unwrap();
    assert_eq!(
        (a.name.as_str(), a.sort_name.as_deref(), a.score),
        ("Radiohead", Some("Radiohead"), 100)
    );
    let g = c.release_group(uuid(OK_COMPUTER)).await.unwrap();
    assert_eq!(g.title, "OK Computer");
    assert_eq!(g.artist_name, "Radiohead");
    assert_eq!(g.year, Some(1997));
}

#[tokio::test]
async fn release_tracklist_parses_discs_and_durations() {
    let server = MockServer::start().await;
    let rel = "c0000000-0000-4000-8000-000000000002";
    Mock::given(path(format!("/ws/2/release/{rel}")))
        .and(query_param("inc", "recordings artist-credits"))
        .respond_with(json("release"))
        .expect(1)
        .mount(&server)
        .await;
    let t = client(&server).release_tracklist(uuid(rel)).await.unwrap();
    assert_eq!(t.release_mbid, uuid(rel));
    assert_eq!(t.tracks.len(), 4);
    assert_eq!(
        (
            t.tracks[0].disc_no,
            t.tracks[0].position,
            t.tracks[0].title.as_str()
        ),
        (1, 1, "Airbag")
    );
    assert_eq!(t.tracks[0].duration_ms, Some(284_000));
    assert_eq!(
        t.tracks[1].duration_ms,
        Some(387_000),
        "длина берётся из recording"
    );
    assert_eq!(t.tracks[2].duration_ms, None);
    assert_eq!((t.tracks[3].disc_no, t.tracks[3].position), (2, 1));
    assert_eq!(
        t.tracks[0].mbid_recording,
        uuid("f0000000-0000-4000-8000-000000000001")
    );
}

#[tokio::test]
async fn artist_release_groups_paginates() {
    let server = MockServer::start().await;
    for (offset, name) in [
        ("0", "artist_release_groups_p1"),
        ("2", "artist_release_groups_p2"),
    ] {
        Mock::given(path("/ws/2/release-group"))
            .and(query_param("artist", RADIOHEAD))
            .and(query_param("type", "album|ep"))
            .and(query_param("limit", "100"))
            .and(query_param("offset", offset))
            .respond_with(json(name))
            .expect(1)
            .mount(&server)
            .await;
    }
    let groups = client(&server)
        .artist_release_groups(uuid(RADIOHEAD), &["album", "ep"])
        .await
        .unwrap();
    let titles: Vec<_> = groups.iter().map(|g| g.title.as_str()).collect();
    assert_eq!(titles, vec!["Pablo Honey", "The Bends", "OK Computer"]);
    assert!(groups.iter().all(|g| g.artist_mbid == uuid(RADIOHEAD)));
}

#[tokio::test]
async fn pick_canonical_release_prefers_digital_with_modal_track_count() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", OK_COMPUTER))
        .and(query_param("status", "official"))
        .respond_with(json("releases_browse"))
        .expect(1)
        .mount(&server)
        .await;
    let r = client(&server)
        .pick_canonical_release(uuid(OK_COMPUTER))
        .await
        .unwrap();
    // XW + Digital Media + 12 треков (мода) — лучше GB CD, deluxe (24) и винила
    assert_eq!(r, uuid("c0000000-0000-4000-8000-000000000002"));
}

#[tokio::test]
async fn pick_canonical_release_falls_back_to_unofficial() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("status", "official"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"releases": []})))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release"))
        .and(query_param_is_missing("status"))
        .respond_with(json("releases_browse_unofficial"))
        .mount(&server)
        .await;
    let r = client(&server)
        .pick_canonical_release(uuid(OK_COMPUTER))
        .await
        .unwrap();
    assert_eq!(r, uuid("c0000000-0000-4000-8000-000000000009"));

    // вообще нет релизов → NotFound
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/release"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"releases": []})))
        .mount(&server)
        .await;
    assert!(matches!(
        client(&server)
            .pick_canonical_release(uuid(OK_COMPUTER))
            .await,
        Err(MbError::NotFound)
    ));
}

#[tokio::test]
async fn canonical_release_with_tracklist_is_one_request_when_all_releases_fit() {
    let server = MockServer::start().await;
    let rel = "c0000000-0000-4000-8000-000000000002";
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", OK_COMPUTER))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "release-count": 1,
            "releases": [{
                "id": rel, "country": "XW", "date": "1997-05-21",
                "media": [{"position": 1, "format": "Digital Media", "track-count": 1,
                    "tracks": [{"id": "d0000000-0000-4000-8000-000000000001", "position": 1,
                        "title": "Airbag", "length": 284000,
                        "recording": {"id": "e0000000-0000-4000-8000-000000000001", "length": 284000}}]}]
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    let (id, tl) = client(&server)
        .canonical_release_with_tracklist(uuid(OK_COMPUTER))
        .await
        .unwrap();
    assert_eq!(id, uuid(rel));
    assert_eq!(tl.tracks.len(), 1);
    assert_eq!(tl.tracks[0].title, "Airbag");
}

#[tokio::test]
async fn canonical_release_with_tracklist_falls_back_when_releases_do_not_fit_one_page() {
    let server = MockServer::start().await;
    // страница неполная (count > releases): быстрый путь не применяется, идут два запроса прежнего пути
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", OK_COMPUTER))
        .respond_with(json("releases_browse"))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release/c0000000-0000-4000-8000-000000000002"))
        .respond_with(json("release"))
        .expect(1)
        .mount(&server)
        .await;
    let (id, tl) = client(&server)
        .canonical_release_with_tracklist(uuid(OK_COMPUTER))
        .await
        .unwrap();
    assert_eq!(id, uuid("c0000000-0000-4000-8000-000000000002"));
    assert!(!tl.tracks.is_empty());
}

#[tokio::test]
async fn retries_on_503_then_succeeds() {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(2)
        .expect(2)
        .mount(&server)
        .await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .expect(1)
        .mount(&server)
        .await;
    let a = client(&server).artist(uuid(RADIOHEAD)).await.unwrap();
    assert_eq!(a.name, "Radiohead");
}

#[tokio::test]
async fn gives_up_after_three_retries() {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
        .expect(4) // первая попытка + 3 повтора
        .mount(&server)
        .await;
    assert!(matches!(
        client(&server).artist(uuid(RADIOHEAD)).await,
        Err(MbError::RateLimited)
    ));
}

#[tokio::test]
async fn not_found_and_other_errors() {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path(format!("/ws/2/release-group/{OK_COMPUTER}")))
        .respond_with(ResponseTemplate::new(400).set_body_string("bad"))
        .expect(1)
        .mount(&server)
        .await;
    let c = client(&server);
    assert!(matches!(
        c.artist(uuid(RADIOHEAD)).await,
        Err(MbError::NotFound)
    ));
    assert!(matches!(
        c.release_group(uuid(OK_COMPUTER)).await,
        Err(MbError::Http { status: 400, .. })
    ));
}

#[tokio::test]
async fn parallel_identical_requests_are_single_flight() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist").set_delay(Duration::from_millis(300)))
        .expect(1)
        .mount(&server)
        .await;
    let c = client(&server);
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..6 {
        let c = c.clone();
        set.spawn(async move { c.search_artists("radiohead", 5).await.unwrap().len() });
    }
    while let Some(r) = set.join_next().await {
        assert_eq!(r.unwrap(), 2);
    }
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn second_call_is_served_from_mb_cache(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .expect(2)
        .mount(&server)
        .await;
    let c = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");

    // кэш общий для клиентов (в т.ч. «перезапуск процесса»)
    let c2 = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    assert_eq!(c2.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    // TTL: lookup кэшируется на ~7 дней
    let secs: f64 =
        sqlx::query_scalar("SELECT extract(epoch FROM expires_at - now())::float8 FROM mb_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        (6.9 * 86400.0..7.1 * 86400.0).contains(&secs),
        "ttl = {secs}"
    );

    // истёкшая запись → отдаётся сразу, а в фоне уходит новый HTTP-запрос
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    wait_requests(&server, 2).await;
    wait_fresh(&pool).await;
}

/// Ждёт, пока мок не получит `n` запросов (фоновое обновление кэша).
async fn wait_requests(server: &MockServer, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.received_requests().await.unwrap().len() < n {
        assert!(Instant::now() < deadline, "ожидали {n} запросов");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Ждёт, пока все записи кэша не станут свежими.
async fn wait_fresh(pool: &PgPool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let stale: i64 =
            sqlx::query_scalar("SELECT count(*) FROM mb_cache WHERE expires_at <= now()")
                .fetch_one(pool)
                .await
                .unwrap();
        if stale == 0 {
            return;
        }
        assert!(Instant::now() < deadline, "кэш не обновился");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn background_client_waits_for_a_fresh_answer_instead_of_stale(pool: PgPool) {
    let server = MockServer::start().await;
    let p = format!("/ws/2/artist/{RADIOHEAD}");
    Mock::given(path(p.clone()))
        .respond_with(json("artist"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let c = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    c.artist(uuid(RADIOHEAD)).await.unwrap();
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    Mock::given(path(p))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": RADIOHEAD, "name": "Radiohead (updated)"
        })))
        .mount(&server)
        .await;
    // Импорт (фоновый клиент) не довольствуется устаревшим ответом.
    assert_eq!(
        c.background().artist(uuid(RADIOHEAD)).await.unwrap().name,
        "Radiohead (updated)"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn listenbrainz_popularity_is_cached_per_mbid(pool: PgPool) {
    let server = MockServer::start().await;
    let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
    Mock::given(method("POST"))
        .and(path("/1/popularity/recording"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "recording_mbid": a.to_string(), "total_listen_count": 42 }
        ])))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.lb_base = Some(format!("{}/1/", server.uri()).parse().unwrap());
    let c = MbClient::with_config(c, Some(pool.clone())).unwrap();
    let first = c.recording_popularity(&[a, b]).await;
    assert_eq!(first.get(&a), Some(&42));
    // Повтор — из кэша, без запроса; у записи без прослушиваний — закэшированный ноль.
    let again = c.recording_popularity(&[a, b]).await;
    assert_eq!((again.get(&a), again.get(&b)), (Some(&42), Some(&0)));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    // Пересекающийся набор: спрашивается только новое.
    let cc = Uuid::from_u128(3);
    c.recording_popularity(&[a, cc]).await;
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 2);
    let body: serde_json::Value = serde_json::from_slice(&reqs[1].body).unwrap();
    assert_eq!(body["recording_mbids"], serde_json::json!([cc.to_string()]));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn listenbrainz_failure_is_not_cached(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.lb_base = Some(format!("{}/1/", server.uri()).parse().unwrap());
    let c = MbClient::with_config(c, Some(pool.clone())).unwrap();
    assert!(c
        .recording_popularity(&[Uuid::from_u128(1)])
        .await
        .is_empty());
    assert!(c
        .release_group_popularity(&[Uuid::from_u128(1)])
        .await
        .is_empty());
    let cached: i64 = sqlx::query_scalar("SELECT count(*) FROM mb_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cached, 0);
}

#[tokio::test]
async fn limiter_spaces_requests() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.limits = MbLimits::paced(5.0);
    let client = MbClient::with_config(c, None).unwrap();
    let start = Instant::now();
    for q in ["aaa", "bbb", "ccc"] {
        client.search_artists(q, 5).await.unwrap();
    }
    assert!(
        start.elapsed() >= Duration::from_millis(400),
        "elapsed {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn interactive_requests_jump_the_background_queue() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.limits = MbLimits::paced(1000.0 / 150.0);
    let client = MbClient::with_config(c, None).unwrap();
    assert_eq!(client.priority(), Priority::Interactive);
    assert_eq!(client.background().priority(), Priority::Background);

    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut set = tokio::task::JoinSet::new();
    for i in 0..5 {
        let bg = client.background();
        let order = order.clone();
        set.spawn(async move {
            bg.search_artists(&format!("bg{i}x"), 5).await.unwrap();
            order.lock().unwrap().push(format!("bg{i}"));
        });
    }
    tokio::time::sleep(Duration::from_millis(40)).await;
    let (c2, order2) = (client.clone(), order.clone());
    set.spawn(async move {
        c2.search_artists("interactive", 5).await.unwrap();
        order2.lock().unwrap().push("interactive".into());
    });
    while set.join_next().await.is_some() {}

    let order = order.lock().unwrap().clone();
    let pos = order.iter().position(|s| s == "interactive").unwrap();
    assert!(
        pos <= 1,
        "интерактивный запрос должен идти сразу за уже занявшим слот: {order:?}"
    );
}

#[test]
fn cover_url_format() {
    assert_eq!(
        cover_url(uuid(OK_COMPUTER), 250),
        format!("https://coverartarchive.org/release-group/{OK_COMPUTER}/front-250")
    );
}

/// Живой тест против musicbrainz.org (запускать вручную: `cargo test -p nimbus-musicbrainz -- --ignored`).
#[tokio::test]
#[ignore]
async fn live_search_radiohead() {
    let ua = std::env::var("NIMBUS_MB_USER_AGENT")
        .unwrap_or_else(|_| "Nimbus/0.1 ( https://github.com/your/nimbus )".into());
    let client = MbClient::new(&ua, None).unwrap();
    let hits = client.search_artists("radiohead", 5).await.unwrap();
    assert!(hits.iter().any(|h| h.mbid == uuid(RADIOHEAD)), "{hits:?}");
}

/// Живой тест пакетного импорта (проверяет реальный предел `limit` для browse с `inc=recordings`).
#[tokio::test]
#[ignore]
async fn live_bulk_releases_for_artist() {
    let ua = std::env::var("NIMBUS_MB_USER_AGENT")
        .unwrap_or_else(|_| "Nimbus/0.1 ( https://github.com/your/nimbus )".into());
    let client = MbClient::new(&ua, None).unwrap();
    let out = client
        .artist_releases_bulk_filtered(uuid(RADIOHEAD), &["album"], |g| {
            g.secondary_types.is_empty()
        })
        .await
        .unwrap();
    assert!(out.groups.iter().any(|b| b.group.mbid == uuid(OK_COMPUTER)));
}

// ---- реальные ответы MusicBrainz (tests/fixtures/real_*.json, записаны 2026-11-11) ----

#[tokio::test]
async fn real_responses_parse() {
    let server = MockServer::start().await;
    let routes = [
        ("/ws/2/artist", "real_search_artist"),
        ("/ws/2/release-group", "real_search_release_group"),
        ("/ws/2/recording", "real_search_recording"),
        ("/ws/2/release", "real_releases_browse"),
    ];
    for (p, f) in routes {
        Mock::given(path(p))
            .respond_with(json(f))
            .mount(&server)
            .await;
    }
    let c = client(&server);

    let artists = c.search_artists("radiohead", 3).await.unwrap();
    assert_eq!(artists[0].mbid, uuid(RADIOHEAD));
    assert_eq!(artists[0].name, "Radiohead");
    assert!(artists.iter().all(|a| a.score <= 100));

    let groups = c
        .search_release_groups("ok computer radiohead", 3)
        .await
        .unwrap();
    assert!(
        groups
            .iter()
            .any(|g| g.mbid == uuid(OK_COMPUTER) && g.year == Some(1997)),
        "{groups:?}"
    );

    let recs = c
        .search_recordings("paranoid android radiohead", 3)
        .await
        .unwrap();
    assert!(!recs.is_empty());
    assert!(recs.iter().all(|r| !r.artist_name.is_empty()));

    // 39 официальных релизов OK Computer: каноничный должен существовать в ответе
    let canon = c.pick_canonical_release(uuid(OK_COMPUTER)).await.unwrap();
    let raw: serde_json::Value = serde_json::from_str(&fixture("real_releases_browse")).unwrap();
    assert!(raw["releases"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == canon.to_string()));
}

#[tokio::test]
async fn real_tracklist_and_release_groups_parse() {
    let server = MockServer::start().await;
    Mock::given(path_regex_release())
        .respond_with(json("real_release"))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release-group"))
        .respond_with(json("real_artist_release_groups"))
        .mount(&server)
        .await;
    let c = client(&server);

    let raw: serde_json::Value = serde_json::from_str(&fixture("real_release")).unwrap();
    let id = uuid(raw["id"].as_str().unwrap());
    let t = c.release_tracklist(id).await.unwrap();
    assert_eq!(t.release_mbid, id);
    assert_eq!(t.tracks.len(), 12, "OK Computer — 12 треков");
    assert_eq!(t.tracks[0].title, "Airbag");
    assert_eq!((t.tracks[0].disc_no, t.tracks[0].position), (1, 1));
    assert!(t.tracks.iter().all(|t| t.duration_ms.is_some()));

    let groups = c
        .artist_release_groups(uuid(RADIOHEAD), &["album", "ep"])
        .await
        .unwrap();
    assert!(!groups.is_empty());
    assert!(groups
        .iter()
        .all(|g| g.artist_mbid == uuid(RADIOHEAD) && g.year.is_some()));
}

fn path_regex_release() -> wiremock::matchers::PathRegexMatcher {
    wiremock::matchers::path_regex(r"^/ws/2/release/[0-9a-f-]{36}$")
}

#[tokio::test]
async fn recording_lookup_picks_album_release_group() {
    let server = MockServer::start().await;
    let rec = "f0000000-0000-4000-8000-000000000002";
    Mock::given(path(format!("/ws/2/recording/{rec}")))
        .and(query_param("inc", "artist-credits releases release-groups"))
        .respond_with(json("recording_lookup"))
        .expect(1)
        .mount(&server)
        .await;
    let hit = client(&server).recording(uuid(rec)).await.unwrap();
    assert_eq!(hit.title, "Paranoid Android");
    assert_eq!(hit.artist_mbid, uuid(RADIOHEAD));
    assert_eq!(hit.duration_ms, Some(387_000));
    assert_eq!(hit.release_group_mbid, Some(uuid(OK_COMPUTER)));
}

// ------------------------------------------------------------------ пакетный импорт дискографии

fn n_uuid(kind: u128, n: usize) -> Uuid {
    Uuid::from_u128(kind << 64 | n as u128)
}

fn rg_json(n: usize, ty: &str) -> serde_json::Value {
    serde_json::json!({
        "id": n_uuid(1, n), "title": format!("Album {n}"), "primary-type": ty,
        "secondary-types": [], "first-release-date": format!("{}-01-01", 1990 + n),
        "artist-credit": [{"name": "Radiohead", "artist": {"id": RADIOHEAD, "name": "Radiohead"}}]
    })
}

/// Релиз группы `group`; `tracks` — сколько дорожек реально пришло (может быть меньше `track_count`).
fn release_json(
    group: usize,
    k: usize,
    format: &str,
    country: &str,
    track_count: usize,
    tracks: usize,
) -> serde_json::Value {
    let id = n_uuid(2, group * 100 + k);
    let tracks: Vec<_> = (1..=tracks)
        .map(|p| {
            serde_json::json!({
                "id": n_uuid(3, group * 10_000 + k * 100 + p), "position": p,
                "title": format!("G{group} K{k} T{p}"), "length": 200_000 + p,
                "recording": {"id": n_uuid(4, group * 100 + p), "length": 200_000 + p}
            })
        })
        .collect();
    serde_json::json!({
        "id": id, "date": format!("{}-06-01", 1990 + group + k), "country": country,
        "release-group": {"id": n_uuid(1, group)},
        "media": [{"position": 1, "format": format, "track-count": track_count, "tracks": tracks}]
    })
}

/// Два релиза на группу: CD (GB) и Digital Media (XW) — каноничным выбирается второй.
fn group_releases(group: usize) -> Vec<serde_json::Value> {
    vec![
        release_json(group, 1, "CD", "GB", 10, 10),
        release_json(group, 2, "Digital Media", "XW", 10, 10),
    ]
}

fn canonical_id(group: usize) -> Uuid {
    n_uuid(2, group * 100 + 2)
}

fn page(count: usize, key: &str, items: Vec<serde_json::Value>) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "release-count": count, "release-group-count": count, key: items
    }))
}

async fn mount_groups(server: &MockServer, groups: &[usize]) {
    Mock::given(path("/ws/2/release-group"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(
            groups.len(),
            "release-groups",
            groups.iter().map(|g| rg_json(*g, "Album")).collect(),
        ))
        .mount(server)
        .await;
}

async fn count_for(server: &MockServer, p: &str) -> usize {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path() == p)
        .count()
}

#[tokio::test]
async fn bulk_one_page_needs_few_requests_where_per_group_path_needs_many() {
    let groups: Vec<usize> = (1..=12).collect();
    let all: Vec<_> = groups.iter().flat_map(|g| group_releases(*g)).collect();

    // Пакетный путь: список групп + одна страница релизов.
    let bulk = MockServer::start().await;
    mount_groups(&bulk, &groups).await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("artist", RADIOHEAD))
        .and(query_param("status", "official"))
        .and(query_param("type", "album|ep"))
        .and(query_param(
            "inc",
            "release-groups media recordings artist-credits",
        ))
        .respond_with(page(all.len(), "releases", all.clone()))
        .mount(&bulk)
        .await;
    let out = client(&bulk)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album", "ep"])
        .await
        .unwrap();
    let bulk_requests = bulk.received_requests().await.unwrap().len();
    assert_eq!(out.groups.len(), 12);
    assert!(out.unavailable.is_empty());
    assert!(bulk_requests <= 3, "запросов: {bulk_requests}");
    for (i, b) in out.groups.iter().enumerate() {
        let g = i + 1;
        assert_eq!(b.group.mbid, n_uuid(1, g), "порядок групп сохраняется");
        assert_eq!(b.group.artist_mbid, uuid(RADIOHEAD));
        assert_eq!(b.release, canonical_id(g));
        assert_eq!(b.tracklist.release_mbid, canonical_id(g));
        assert_eq!(b.tracklist.tracks.len(), 10);
        assert_eq!(b.tracklist.tracks[0].title, format!("G{g} K2 T1"));
    }

    // Прежний путь: список групп + по запросу на группу.
    let old = MockServer::start().await;
    mount_groups(&old, &groups).await;
    for g in &groups {
        Mock::given(path("/ws/2/release"))
            .and(query_param("release-group", n_uuid(1, *g).to_string()))
            .respond_with(page(2, "releases", group_releases(*g)))
            .mount(&old)
            .await;
    }
    let c = client(&old);
    let rgs = c
        .artist_release_groups(uuid(RADIOHEAD), &["album", "ep"])
        .await
        .unwrap();
    for g in rgs {
        c.canonical_release_with_tracklist(g.mbid).await.unwrap();
    }
    let old_requests = old.received_requests().await.unwrap().len();
    assert!(old_requests >= 13, "запросов: {old_requests}");
}

#[tokio::test]
async fn bulk_pages_by_received_count_and_dedups_on_page_boundary() {
    let groups: Vec<usize> = (1..=13).collect();
    let all: Vec<_> = groups.iter().flat_map(|g| group_releases(*g)).collect(); // 26 релизов
    let server = MockServer::start().await;
    mount_groups(&server, &groups).await;
    // Сервер отдаёт по 20 (меньше запрошенных 25): листаем по фактически полученному числу.
    // Релиз на границе приходит дважды.
    let first: Vec<_> = all[..20].to_vec();
    let mut second: Vec<_> = all[19..].to_vec();
    second.truncate(7);
    for (offset, items) in [("0", first), ("20", second)] {
        Mock::given(path("/ws/2/release"))
            .and(query_param("artist", RADIOHEAD))
            .and(query_param("offset", offset))
            .respond_with(page(26, "releases", items))
            .mount(&server)
            .await;
    }
    let out = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await
        .unwrap();
    assert_eq!(out.groups.len(), 13);
    // Группа 10 разрезана границей страниц (релизы 19 и 20): выбор по обоим.
    assert_eq!(out.groups[9].release, canonical_id(10));
    assert_eq!(
        count_for(&server, "/ws/2/release").await,
        2,
        "две страницы релизов и ни одного запроса на группу"
    );
}

#[tokio::test]
async fn bulk_incomplete_tracklist_is_fetched_per_group() {
    let groups = [1usize, 2];
    let server = MockServer::start().await;
    mount_groups(&server, &groups).await;
    // У группы 2 выбранный релиз пришёл без части дорожек (носитель 10, дорожек 4).
    let mut releases = group_releases(1);
    releases.push(release_json(2, 1, "CD", "GB", 10, 10));
    releases.push(release_json(2, 2, "Digital Media", "XW", 10, 4));
    Mock::given(path("/ws/2/release"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(releases.len(), "releases", releases))
        .mount(&server)
        .await;
    // Добор по группе: прежний путь отдаёт полный релиз.
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 2).to_string()))
        .respond_with(page(
            2,
            "releases",
            vec![
                release_json(2, 1, "CD", "GB", 10, 10),
                release_json(2, 2, "Digital Media", "XW", 10, 10),
            ],
        ))
        .expect(1)
        .mount(&server)
        .await;
    let out = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await
        .unwrap();
    assert_eq!(out.groups.len(), 2);
    assert_eq!(out.groups[0].tracklist.tracks.len(), 10);
    assert_eq!(out.groups[1].release, canonical_id(2));
    assert_eq!(
        out.groups[1].tracklist.tracks.len(),
        10,
        "добрано по группе"
    );
}

#[tokio::test]
async fn bulk_unsupported_response_falls_back_to_per_group_requests() {
    for bulk_response in [
        ResponseTemplate::new(400).set_body_string("unsupported inc"),
        // Страница без `release-group`: `inc=release-groups` проигнорирован.
        page(
            2,
            "releases",
            vec![serde_json::json!({"id": n_uuid(2, 1), "media": []}); 1]
                .into_iter()
                .chain(vec![serde_json::json!({"id": n_uuid(2, 2), "media": []})])
                .collect(),
        ),
    ] {
        let groups = [1usize, 2, 3];
        let server = MockServer::start().await;
        mount_groups(&server, &groups).await;
        Mock::given(path("/ws/2/release"))
            .and(query_param("artist", RADIOHEAD))
            .respond_with(bulk_response)
            .mount(&server)
            .await;
        for g in groups {
            Mock::given(path("/ws/2/release"))
                .and(query_param("release-group", n_uuid(1, g).to_string()))
                .respond_with(page(2, "releases", group_releases(g)))
                .expect(1)
                .mount(&server)
                .await;
        }
        let out = client(&server)
            .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
            .await
            .unwrap();
        assert_eq!(out.groups.len(), 3);
        assert_eq!(out.groups[2].release, canonical_id(3));
    }
}

#[tokio::test]
async fn bulk_groups_without_official_release_are_unavailable_or_fall_back_to_unofficial() {
    let groups = [1usize, 2, 3];
    let server = MockServer::start().await;
    mount_groups(&server, &groups).await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(2, "releases", group_releases(1)))
        .mount(&server)
        .await;
    // Группа 2 — совсем без релизов; у группы 3 только неофициальные (прежний путь их берёт).
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 2).to_string()))
        .respond_with(page(0, "releases", vec![]))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 3).to_string()))
        .and(query_param("status", "official"))
        .respond_with(page(0, "releases", vec![]))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 3).to_string()))
        .and(query_param_is_missing("status"))
        .respond_with(page(
            1,
            "releases",
            vec![release_json(3, 1, "CD", "GB", 10, 10)],
        ))
        .mount(&server)
        .await;
    Mock::given(path(format!("/ws/2/release/{}", n_uuid(2, 301))))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": n_uuid(2, 301),
            "media": release_json(3, 1, "CD", "GB", 10, 10)["media"].clone()
        })))
        .mount(&server)
        .await;
    let out = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await
        .unwrap();
    assert_eq!(
        out.groups.iter().map(|b| b.group.mbid).collect::<Vec<_>>(),
        vec![n_uuid(1, 1), n_uuid(1, 3)]
    );
    assert_eq!(
        out.unavailable.iter().map(|g| g.mbid).collect::<Vec<_>>(),
        vec![n_uuid(1, 2)]
    );
}

#[tokio::test]
async fn bulk_filter_skips_requests_for_dropped_groups() {
    let groups = [1usize, 2, 3];
    let server = MockServer::start().await;
    mount_groups(&server, &groups).await;
    // Релизов нет вовсе: без фильтра пошёл бы добор по каждой группе.
    Mock::given(path("/ws/2/release"))
        .respond_with(page(0, "releases", vec![]))
        .mount(&server)
        .await;
    let out = client(&server)
        .artist_releases_bulk_filtered(uuid(RADIOHEAD), &["album"], |_| false)
        .await
        .unwrap();
    assert!(out.groups.is_empty() && out.unavailable.is_empty());
    assert_eq!(count_for(&server, "/ws/2/release").await, 0);
}

#[tokio::test]
async fn bulk_falls_back_when_per_group_requests_are_cheaper() {
    // 1 группа, а релизов столько, что страниц больше одной на группу → пакетный путь не выгоден.
    let server = MockServer::start().await;
    mount_groups(&server, &[1]).await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(26, "releases", group_releases(1)))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 1).to_string()))
        .respond_with(page(2, "releases", group_releases(1)))
        .expect(1)
        .mount(&server)
        .await;
    let out = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await
        .unwrap();
    assert_eq!(out.groups.len(), 1);
}

#[tokio::test]
async fn bulk_propagates_throttling_instead_of_falling_back() {
    let server = MockServer::start().await;
    mount_groups(&server, &[1, 2]).await;
    Mock::given(path("/ws/2/release"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let r = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await;
    assert!(matches!(r, Err(MbError::RateLimited)), "{r:?}");
}

#[tokio::test]
async fn bulk_per_group_errors_other_than_not_found_fail_the_import() {
    let server = MockServer::start().await;
    mount_groups(&server, &[1]).await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(0, "releases", vec![]))
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/release"))
        .and(query_param("release-group", n_uuid(1, 1).to_string()))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let r = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await;
    assert!(matches!(r, Err(MbError::Http { status: 500, .. })), "{r:?}");
}

#[tokio::test]
async fn bulk_choice_equals_canonical_release_with_tracklist_on_real_data() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/release-group"))
        .and(query_param("artist", RADIOHEAD))
        .respond_with(page(
            1,
            "release-groups",
            vec![serde_json::json!({
                "id": OK_COMPUTER, "title": "OK Computer", "primary-type": "Album",
                "secondary-types": [], "first-release-date": "1997-05-21",
                "artist-credit": [{"name": "Radiohead", "artist": {"id": RADIOHEAD, "name": "Radiohead"}}]
            })],
        ))
        .mount(&server)
        .await;
    // Та же реальная страница отвечает и на пакетный запрос, и на запрос по группе.
    Mock::given(path("/ws/2/release"))
        .respond_with(json("real_releases_by_artist"))
        .mount(&server)
        .await;
    let c = client(&server);
    let bulk = c
        .artist_releases_bulk(uuid(RADIOHEAD), &["album"])
        .await
        .unwrap();
    let (release, tracklist) = c
        .canonical_release_with_tracklist(uuid(OK_COMPUTER))
        .await
        .unwrap();
    assert_eq!(bulk.groups.len(), 1);
    assert_eq!(bulk.groups[0].release, release);
    assert_eq!(bulk.groups[0].tracklist, tracklist);
    assert_eq!(tracklist.tracks.len(), 12);
}

// ------------------------------------------------------------------ stale-if-error

async fn expire(pool: &PgPool) {
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '1 hour'")
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stale_cache_entry_is_served_on_503_and_refreshed_by_a_good_response(pool: PgPool) {
    let server = MockServer::start().await;
    let p = format!("/ws/2/artist/{RADIOHEAD}");
    Mock::given(path(p.clone()))
        .respond_with(json("artist"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let c = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    expire(&pool).await;

    // Сервис недоступен: отдаём просроченную запись.
    Mock::given(path(p.clone()))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(10)
        .mount(&server)
        .await;
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");

    // Сервис ожил: просроченная запись отдаётся сразу, а фоновое обновление кладёт свежий ответ.
    server.reset().await;
    Mock::given(path(p))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": RADIOHEAD, "name": "Radiohead (updated)"
        })))
        .mount(&server)
        .await;
    // Фоновое обновление с 503 могло ещё висеть в single-flight и подхватить этот вызов, поэтому
    // повторяем запрос, пока свежий ответ не ляжет в кэш.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        c.artist(uuid(RADIOHEAD)).await.unwrap();
        let stale: i64 =
            sqlx::query_scalar("SELECT count(*) FROM mb_cache WHERE expires_at <= now()")
                .fetch_one(&pool)
                .await
                .unwrap();
        if stale == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "кэш не обновился");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        c.artist(uuid(RADIOHEAD)).await.unwrap().name,
        "Radiohead (updated)"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stale_cache_entry_is_served_on_network_error(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .mount(&server)
        .await;
    let c = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    c.artist(uuid(RADIOHEAD)).await.unwrap();
    expire(&pool).await;
    drop(server); // порт закрыт → ошибка соединения
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn stale_entry_is_not_used_for_not_found_or_without_entry(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let c = MbClient::with_config(cfg(&server), Some(pool.clone())).unwrap();
    c.artist(uuid(RADIOHEAD)).await.unwrap();
    expire(&pool).await;
    // 404 при фоновом обновлении — сущность пропала из MusicBrainz, но кэш не чистится: прежний ответ остаётся.
    server.reset().await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    assert!(c.artist(uuid(RADIOHEAD)).await.is_ok());
    wait_requests(&server, 1).await;
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM mb_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1);
    // Нет записи — нет и запасного ответа.
    server.reset().await;
    Mock::given(path("/ws/2/artist/b1392450-e666-3926-a536-22c65f834433"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    assert!(matches!(
        c.artist(uuid(OK_COMPUTER)).await,
        Err(MbError::RateLimited)
    ));
}

// ------------------------------------------------------------------ reconfigure, burst

fn mb_settings(server: &MockServer) -> nimbus_core::settings::MusicbrainzSettings {
    nimbus_core::settings::MusicbrainzSettings {
        base_url: format!("{}/ws/2/", server.uri()),
        ..Default::default()
    }
}

#[tokio::test]
async fn reconfigure_switches_base_url_and_limits_without_new_client() {
    let (a, b) = (MockServer::start().await, MockServer::start().await);
    for s in [&a, &b] {
        Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
            .respond_with(json("artist"))
            .mount(s)
            .await;
    }
    let mut c = cfg(&a);
    c.limits = MbLimits::paced(0.5); // один запрос в 2 с, burst 1
    let client = MbClient::with_config(c, None).unwrap();
    client.artist(uuid(RADIOHEAD)).await.unwrap();
    assert_eq!(a.received_requests().await.unwrap().len(), 1);

    // Зеркало (`effective()`: без лимита) — следующий запрос идёт на новый адрес и без ожидания.
    client.reconfigure(&mb_settings(&b)).unwrap();
    let t = Instant::now();
    for _ in 0..3 {
        client
            .search_artists(&format!("q{}", t.elapsed().as_nanos()), 5)
            .await
            .ok();
    }
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    assert_eq!(a.received_requests().await.unwrap().len(), 1);
    assert_eq!(b.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn reconfigure_lets_in_flight_requests_finish_on_the_old_server() {
    let (slow, fast) = (MockServer::start().await, MockServer::start().await);
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist").set_delay(Duration::from_millis(300)))
        .mount(&slow)
        .await;
    Mock::given(path(format!("/ws/2/artist/{RADIOHEAD}")))
        .respond_with(json("artist"))
        .mount(&fast)
        .await;
    let client = MbClient::with_config(cfg(&slow), None).unwrap();
    let in_flight = {
        let c = client.clone();
        tokio::spawn(async move { c.artist(uuid(RADIOHEAD)).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    client.reconfigure(&mb_settings(&fast)).unwrap();
    assert_eq!(in_flight.await.unwrap().unwrap().name, "Radiohead");
    assert_eq!(slow.received_requests().await.unwrap().len(), 1);
    assert_eq!(fast.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn reconfigure_rejects_unparsable_base_url() {
    let server = MockServer::start().await;
    let client = client(&server);
    let mut s = mb_settings(&server);
    s.base_url = "not a url".into();
    assert!(matches!(client.reconfigure(&s), Err(MbError::Transport(_))));
}

#[tokio::test]
async fn warm_bucket_lets_an_interactive_search_through_without_waiting() {
    let server = MockServer::start().await;
    for p in ["artist", "release-group", "recording"] {
        Mock::given(path(format!("/ws/2/{p}")))
            .respond_with(json(match p {
                "artist" => "search_artist",
                "release-group" => "search_release_group",
                _ => "search_recording",
            }))
            .mount(&server)
            .await;
    }
    let mut c = cfg(&server);
    c.limits = MbLimits::public(); // 1 запрос/с, burst 3 — как у публичного сервера
    let client = MbClient::with_config(c, None).unwrap();
    let t = Instant::now();
    let (a, g, r) = tokio::join!(
        client.search_artists("radiohead", 5),
        client.search_release_groups("radiohead", 5),
        client.search_recordings("radiohead", 5),
    );
    assert!(a.is_ok() && g.is_ok() && r.is_ok());
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "три запроса поиска должны уйти разом: {:?}",
        t.elapsed()
    );
    // Ведро опустошено: четвёртый ждёт ~1 с.
    let t = Instant::now();
    client.search_artists("another", 5).await.unwrap();
    assert!(
        t.elapsed() >= Duration::from_millis(800),
        "{:?}",
        t.elapsed()
    );
}

#[tokio::test]
async fn throttling_slows_the_client_down_for_subsequent_requests() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.limits = MbLimits {
        rate_per_sec: 20.0,
        burst: 1,
        max_concurrent: 1,
    };
    let client = MbClient::with_config(c, None).unwrap();
    let t = Instant::now();
    client.search_artists("aaa", 5).await.unwrap();
    client.search_artists("bbb", 5).await.unwrap();
    // 503 → пауза retry_delay (10 мс) и темп 20 → 10 запросов/с: второй запрос ≥ 100 мс после повтора.
    assert!(
        t.elapsed() >= Duration::from_millis(100),
        "{:?}",
        t.elapsed()
    );
}

/// Измерение шага 30: артист с 30 альбомами (по 2 релиза на альбом), число HTTP-запросов.
/// На публичном лимите (1 запрос/с, burst 3) время ≈ `max(0, запросов − 3)` секунд.
#[tokio::test]
async fn request_budget_for_an_artist_with_30_albums() {
    let groups: Vec<usize> = (1..=30).collect();
    let all: Vec<_> = groups.iter().flat_map(|g| group_releases(*g)).collect(); // 60 релизов
    let server = MockServer::start().await;
    mount_groups(&server, &groups).await;
    for (i, chunk) in all.chunks(25).enumerate() {
        Mock::given(path("/ws/2/release"))
            .and(query_param("artist", RADIOHEAD))
            .and(query_param("offset", (i * 25).to_string()))
            .respond_with(page(all.len(), "releases", chunk.to_vec()))
            .mount(&server)
            .await;
    }
    let t = Instant::now();
    let out = client(&server)
        .artist_releases_bulk(uuid(RADIOHEAD), &["album", "ep"])
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap().len();
    eprintln!(
        "30 альбомов: {requests} запросов (было 31), {:?} без лимита; на публичном лимите ≈ {} с",
        t.elapsed(),
        requests.saturating_sub(3)
    );
    assert_eq!(out.groups.len(), 30);
    assert_eq!(requests, 1 + 3, "список групп + 3 страницы по 25 релизов");
}

/// Регрессия («импорт стоит вечно»): интерактивный запрос бросили, пока он ждал токен в лимитере.
/// Общий запрос в полёте не должен зависать «без хозяина» с флагом «интерактивный ждёт» — иначе
/// фоновые запросы (импорт артиста) не получают токен никогда.
#[tokio::test]
async fn abandoned_interactive_request_does_not_starve_background_requests() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ws/2/artist"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw("{\"artists\": []}", "application/json"),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/ws/2/release-group"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "{\"release-group-count\": 0, \"release-group-offset\": 0, \"release-groups\": []}",
            "application/json",
        ))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.limits = MbLimits::paced(2.0); // токен раз в 0,5 с, burst 1
    let mb = MbClient::with_config(c, None).unwrap();

    // Первый интерактивный запрос забирает токен, второй (другой ключ) встаёт в очередь лимитера и
    // тут же отменяется — как закрытая пользователем страница.
    mb.search_artists("first", 5).await.unwrap();
    let abandoned =
        tokio::time::timeout(Duration::from_millis(50), mb.search_artists("second", 5)).await;
    assert!(abandoned.is_err(), "второй запрос должен был ждать токен");

    let bg = mb.background();
    let res = tokio::time::timeout(
        Duration::from_secs(5),
        bg.artist_release_groups(uuid(RADIOHEAD), &["album"]),
    )
    .await;
    assert!(
        res.is_ok(),
        "фоновый запрос застрял за брошенным интерактивным"
    );
    res.unwrap().unwrap();
}
