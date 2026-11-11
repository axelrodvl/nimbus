use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nimbus_musicbrainz::{cover_url, MbClient, MbConfig, MbError, Priority};
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
    c.min_interval = Duration::from_millis(1);
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

    // истёкшая запись → новый HTTP-запрос
    sqlx::query("UPDATE mb_cache SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(c.artist(uuid(RADIOHEAD)).await.unwrap().name, "Radiohead");
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn limiter_spaces_requests() {
    let server = MockServer::start().await;
    Mock::given(path("/ws/2/artist"))
        .respond_with(json("search_artist"))
        .mount(&server)
        .await;
    let mut c = cfg(&server);
    c.min_interval = Duration::from_millis(200);
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
    c.min_interval = Duration::from_millis(150);
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
