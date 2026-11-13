// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::config::Config;
use nimbus_core::model::{InfoHash, TorrentSource};
use nimbus_trackers::*;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TPB_SCENARIO: &str = include_str!("fixtures/tpb_scenario.json");
const TPB_EMPTY: &str = include_str!("fixtures/tpb_empty.json");
const TPB_REAL: &str = include_str!("fixtures/tpb_real.json");
const TZ_MUSIC: &str = include_str!("fixtures/torznab_music.xml");
const TZ_EMPTY: &str = include_str!("fixtures/torznab_empty.xml");
const TZ_ERROR: &str = include_str!("fixtures/torznab_error.xml");

const FAST: Duration = Duration::from_millis(5);

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

fn tpb(server: &MockServer) -> TpbProvider {
    TpbProvider::with_base_url(http(), &server.uri()).with_min_interval(FAST)
}

fn torznab(server: &MockServer) -> TorznabProvider {
    TorznabProvider::new(http(), &server.uri(), "KEY").with_min_interval(FAST)
}

// ------------------------------------------------------------------ magnet

#[test]
fn magnet_is_url_encoded_and_lowercase() {
    let h = InfoHash::parse("ABCDEF0123456789ABCDEF0123456789ABCDEF01").unwrap();
    assert_eq!(h.as_str(), "abcdef0123456789abcdef0123456789abcdef01");
    let m = build_magnet(
        &h,
        "AC/DC - Back in Black & more (1980)",
        &["udp://t.example:80/announce"],
    );
    assert_eq!(
        m,
        "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01\
         &dn=AC%2FDC%20-%20Back%20in%20Black%20%26%20more%20%281980%29\
         &tr=udp%3A%2F%2Ft.example%3A80%2Fannounce"
    );
    let m = build_magnet(&h, "Кино", PUBLIC_TRACKERS);
    assert!(m.contains("dn=%D0%9A%D0%B8%D0%BD%D0%BE"));
    assert_eq!(m.matches("&tr=").count(), 6);
    // Круговой обход: хеш достаётся обратно.
    assert_eq!(InfoHash::from_magnet(&m), Some(h));
}

// --------------------------------------------------------------------- TPB

#[tokio::test]
async fn tpb_parses_string_numbers_and_filters_categories() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/q.php"))
        .and(query_param("q", "Radiohead OK Computer"))
        .and(query_param("cat", "100"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TPB_SCENARIO))
        .mount(&server)
        .await;

    let found = tpb(&server)
        .search(&SearchQuery::text("Radiohead OK Computer"))
        .await
        .unwrap();
    // Видео (201) и битый хеш отброшены.
    assert_eq!(found.len(), 1);
    let c = &found[0];
    assert_eq!(c.source, TorrentSource::Tpb);
    assert_eq!(c.source_topic_id.as_deref(), Some("111"));
    assert_eq!(c.title, "Radiohead - OK Computer (1997) [FLAC]");
    assert_eq!(
        c.info_hash.as_ref().unwrap().as_str(),
        "abcdef0123456789abcdef0123456789abcdef01"
    );
    assert_eq!((c.seeders, c.leechers), (Some(57), Some(3)));
    assert_eq!(c.size_bytes, Some(512_345_678));
    assert_eq!(c.files_count, Some(14));
    assert_eq!(c.category.as_deref(), Some("104"));
    let magnet = c.magnet.as_deref().unwrap();
    assert!(magnet.starts_with("magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn="));
    assert!(magnet.contains("&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"));
}

#[tokio::test]
async fn tpb_no_results_is_empty() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TPB_EMPTY))
        .mount(&server)
        .await;
    assert!(tpb(&server)
        .search(&SearchQuery::text("zzzz"))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn tpb_real_response_parses() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TPB_REAL))
        .mount(&server)
        .await;
    let found = tpb(&server).search(&SearchQuery::text("x")).await.unwrap();
    assert!(!found.is_empty());
    assert!(found
        .iter()
        .all(|c| c.info_hash.is_some() && c.magnet.is_some()));
}

#[tokio::test]
async fn tpb_errors_are_classified() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("q", "limited"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(query_param("q", "down"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(query_param("q", "html"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>Cloudflare</html>"))
        .mount(&server)
        .await;
    let p = tpb(&server);
    assert!(matches!(
        p.search(&SearchQuery::text("limited")).await,
        Err(ProviderError::RateLimited)
    ));
    assert!(matches!(
        p.search(&SearchQuery::text("down")).await,
        Err(ProviderError::Blocked(_))
    ));
    assert!(matches!(
        p.search(&SearchQuery::text("html")).await,
        Err(ProviderError::Parse(_))
    ));
}

// ----------------------------------------------------------------- Torznab

fn music_query() -> SearchQuery {
    SearchQuery {
        text: "Radiohead OK Computer".into(),
        artist: Some("Radiohead".into()),
        album: Some("OK Computer".into()),
        ..SearchQuery::default()
    }
}

#[tokio::test]
async fn torznab_parses_attrs() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api"))
        .and(query_param("t", "music"))
        .and(query_param("artist", "Radiohead"))
        .and(query_param("album", "OK Computer"))
        .and(query_param("apikey", "KEY"))
        .and(query_param("extended", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(TZ_MUSIC.replace("__DL__", "https://jackett.local/dl/amnesiac")),
        )
        .expect(1)
        .mount(&server)
        .await;

    let found = torznab(&server).search(&music_query()).await.unwrap();
    assert_eq!(found.len(), 3);

    let a = &found[0];
    assert_eq!(a.source, TorrentSource::Torznab);
    assert_eq!(
        a.source_topic_id.as_deref(),
        Some("https://tracker.example/details/42")
    );
    assert_eq!(
        a.info_hash.as_ref().unwrap().as_str(),
        "abcdef0123456789abcdef0123456789abcdef01"
    );
    assert_eq!((a.seeders, a.leechers), (Some(20), Some(5)));
    assert_eq!(a.size_bytes, Some(512_345_678));
    assert_eq!(a.category.as_deref(), Some("3040"));
    assert_eq!(a.files_count, Some(14));
    assert!(a
        .download_url
        .as_deref()
        .unwrap()
        .starts_with("https://jackett.local/dl/"));

    // Хеш берётся из magnet в <link>; peers < seeders не уходит в минус.
    let b = &found[1];
    assert_eq!(
        b.info_hash.as_ref().unwrap().as_str(),
        "0123456789abcdef0123456789abcdef01234567"
    );
    assert!(b.magnet.as_deref().unwrap().starts_with("magnet:?"));
    assert_eq!((b.seeders, b.leechers), (Some(5), Some(0)));

    // Только .torrent-ссылка: хеша пока нет.
    let c = &found[2];
    assert!(c.info_hash.is_none() && c.magnet.is_none() && c.download_url.is_some());
}

#[tokio::test]
async fn torznab_falls_back_to_text_search() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("t", "music"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TZ_EMPTY))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(query_param("t", "search"))
        .and(query_param("q", "Radiohead OK Computer"))
        .and(query_param("cat", "3000"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TZ_MUSIC))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(
        torznab(&server).search(&music_query()).await.unwrap().len(),
        3
    );
}

#[tokio::test]
async fn torznab_without_artist_album_uses_text_search_only() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("t", "search"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TZ_MUSIC))
        .expect(1)
        .mount(&server)
        .await;
    let q = SearchQuery::text("Radiohead discography");
    assert_eq!(torznab(&server).search(&q).await.unwrap().len(), 3);
}

#[tokio::test]
async fn torznab_error_document_is_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(TZ_ERROR))
        .mount(&server)
        .await;
    let err = torznab(&server)
        .search(&SearchQuery::text("x"))
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Auth(m) if m.contains("credentials")));
}

#[tokio::test]
async fn torznab_resolve_downloads_torrent_and_hashes_info() {
    use sha1::{Digest, Sha1};
    let info = b"d6:lengthi3e4:name1:a12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
    let mut torrent = b"d8:announce3:url4:info".to_vec();
    torrent.extend_from_slice(info);
    torrent.push(b'e');
    let expected: String = Sha1::digest(info)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/dl/amnesiac"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(torrent))
        .expect(1)
        .mount(&server)
        .await;
    let xml = TZ_MUSIC.replace("__DL__", &format!("{}/dl/amnesiac", server.uri()));
    Mock::given(method("GET"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_string(xml))
        .mount(&server)
        .await;

    let p = torznab(&server);
    let found = p.search(&music_query()).await.unwrap();
    let resolved = p.resolve(found[2].clone()).await.unwrap();
    assert_eq!(resolved.info_hash.as_ref().unwrap().as_str(), expected);
    assert!(resolved.magnet.unwrap().contains(&expected));
    // Кандидат с хешем не ходит в сеть.
    let same = p.resolve(found[0].clone()).await.unwrap();
    assert_eq!(same, found[0]);
}

// ---------------------------------------------------------------- registry

struct Fake(TorrentSource, Behavior);
enum Behavior {
    Ok,
    Fail,
    Hang,
}

#[async_trait]
impl TorrentProvider for Fake {
    fn source(&self) -> TorrentSource {
        self.0
    }
    async fn search(&self, _q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        match self.1 {
            Behavior::Ok => Ok(vec![TorrentCandidate {
                source: self.0,
                source_topic_id: None,
                title: "t".into(),
                info_hash: None,
                magnet: None,
                download_url: None,
                size_bytes: None,
                seeders: None,
                leechers: None,
                category: None,
                files_count: None,
            }]),
            Behavior::Fail => Err(ProviderError::Blocked("down".into())),
            Behavior::Hang => {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                unreachable!()
            }
        }
    }
}

#[tokio::test]
async fn search_all_survives_failing_and_hanging_providers() {
    let reg = ProviderRegistry::new(vec![
        Arc::new(Fake(TorrentSource::Tpb, Behavior::Fail)),
        Arc::new(Fake(TorrentSource::Torznab, Behavior::Hang)),
        Arc::new(Fake(TorrentSource::Rutracker, Behavior::Ok)),
    ])
    .with_timeout(Duration::from_millis(100));

    let started = std::time::Instant::now();
    let res = reg.search_all(&SearchQuery::text("x")).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(res.len(), 3);
    assert!(matches!(
        res[0],
        (TorrentSource::Tpb, Err(ProviderError::Blocked(_)))
    ));
    assert!(matches!(
        res[1],
        (TorrentSource::Torznab, Err(ProviderError::Timeout))
    ));
    assert!(matches!(&res[2], (TorrentSource::Rutracker, Ok(v)) if v.len() == 1));
}

#[test]
fn registry_is_built_from_config() {
    let mut env = std::collections::HashMap::from([("DATABASE_URL", "postgres://x")]);
    let sources = |env: &_| -> Vec<TorrentSource> {
        ProviderRegistry::from_config(&Config::from_map(env).unwrap())
            .unwrap()
            .sources()
    };
    assert_eq!(sources(&env), [TorrentSource::Tpb]);
    env.insert(
        "NIMBUS_TORZNAB_URL",
        "http://jackett:9117/api/v2.0/indexers/all/results/torznab",
    );
    assert_eq!(sources(&env), [TorrentSource::Tpb, TorrentSource::Torznab]);
    env.insert("NIMBUS_TPB_ENABLED", "false");
    assert_eq!(sources(&env), [TorrentSource::Torznab]);
}

// -------------------------------------------------------------------- live

#[tokio::test]
#[ignore = "живой запрос к apibay.org"]
async fn live_tpb_radiohead() {
    let reg = ProviderRegistry::from_config(
        &Config::from_map(&std::collections::HashMap::from([("DATABASE_URL", "x")])).unwrap(),
    )
    .unwrap();
    let res = reg
        .search_all(&SearchQuery::text("Radiohead OK Computer"))
        .await;
    let (_, found) = &res[0];
    let found = found.as_ref().expect("apibay reachable");
    assert!(!found.is_empty());
}

// ---------------------------------------------------------------- RuTracker

mod rutracker {
    use super::*;
    use wiremock::matchers::{body_bytes, header_exists};
    use wiremock::{Match, Request};

    const SEARCH: &[u8] = include_bytes!("fixtures/rutracker_search.html");
    const LOGGED_OUT: &[u8] = include_bytes!("fixtures/rutracker_search_loggedout.html");
    const LOGIN_OK: &[u8] = include_bytes!("fixtures/rutracker_login_ok.html");
    const CAPTCHA: &[u8] = include_bytes!("fixtures/rutracker_login_captcha.html");
    const TOPIC: &[u8] = include_bytes!("fixtures/rutracker_viewtopic.html");
    const API: &str = include_str!("fixtures/rutracker_api.json");
    const API_NULL: &str = include_str!("fixtures/rutracker_api_null.json");

    fn provider(server: &MockServer, user: bool, cookie: Option<&str>) -> RutrackerProvider {
        RutrackerProvider::new(RutrackerOptions {
            base_url: Some(format!("{}/forum/", server.uri())),
            api_url: Some(server.uri()),
            username: user.then(|| "vadim".to_string()),
            password: user.then(|| "пароль".to_string()),
            cookie: cookie.map(str::to_string),
            min_interval: Some(FAST),
            ..RutrackerOptions::default()
        })
        .unwrap()
    }

    fn html(body: &[u8]) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_bytes(body.to_vec())
    }

    fn login_ok() -> ResponseTemplate {
        html(LOGIN_OK).insert_header("set-cookie", "bb_session=sess1; Path=/")
    }

    /// Совпадает, только если query-строка содержит cp1251-байты.
    struct RawQueryContains(&'static str);
    impl Match for RawQueryContains {
        fn matches(&self, r: &Request) -> bool {
            r.url.query().is_some_and(|q| q.contains(self.0))
        }
    }

    #[tokio::test]
    async fn login_then_search_parses_and_filters() {
        let server = MockServer::start().await;
        // login_username=vadim&login_password=<пароль в cp1251>&login=<вход в cp1251>
        let expected = format!(
            "login_username=vadim&login_password={}&login=%E2%F5%EE%E4",
            "%EF%E0%F0%EE%EB%FC"
        );
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .and(body_bytes(expected.into_bytes()))
            .respond_with(login_ok())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .and(RawQueryContains("nm=%CA%E8%ED%EE%20%C3%F0%F3%EF%EF%E0"))
            .and(header_exists("cookie"))
            .respond_with(html(SEARCH))
            .expect(1)
            .mount(&server)
            .await;

        let p = provider(&server, true, None);
        let found = p.search(&SearchQuery::text("Кино Группа")).await.unwrap();
        // Фильмы и книги отброшены.
        assert_eq!(found.len(), 2);
        let a = &found[0];
        assert_eq!(a.source, TorrentSource::Rutracker);
        assert_eq!(a.source_topic_id.as_deref(), Some("5000001"));
        assert_eq!(a.title, "Кино - Группа крови (1988) [FLAC]");
        assert_eq!(
            a.category.as_deref(),
            Some("Рок, Панк, Альтернатива (Lossless)")
        );
        assert_eq!(a.size_bytes, Some(512_345_678));
        assert_eq!((a.seeders, a.leechers), (Some(57), Some(3)));
        assert!(a.info_hash.is_none() && a.magnet.is_none());
        // Пустые/нечисловые сиды и личи — None.
        let b = &found[1];
        assert_eq!(b.title, "Моцарт - Реквием [APE]");
        assert_eq!((b.seeders, b.leechers), (None, None));
    }

    #[test]
    fn parse_search_directly() {
        let text = rutracker_decode(SEARCH);
        assert_eq!(RutrackerProvider::parse_search(&text).len(), 2);
    }

    fn rutracker_decode(b: &[u8]) -> String {
        encoding_rs::WINDOWS_1251.decode(b).0.into_owned()
    }

    #[tokio::test]
    async fn captcha_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .respond_with(html(CAPTCHA))
            .mount(&server)
            .await;
        let err = provider(&server, true, None)
            .search(&SearchQuery::text("x"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::Auth(m) if m.contains("captcha required") && m.contains("NIMBUS_RUTRACKER_COOKIE"))
        );
    }

    #[tokio::test]
    async fn wrong_password_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .respond_with(html(LOGGED_OUT)) // без Set-Cookie
            .mount(&server)
            .await;
        let err = provider(&server, true, None)
            .search(&SearchQuery::text("x"))
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Auth(_)));
    }

    #[tokio::test]
    async fn cookie_skips_login() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .respond_with(login_ok())
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .and(wiremock::matchers::header("cookie", "bb_session=abc"))
            .respond_with(html(SEARCH))
            .expect(1)
            .mount(&server)
            .await;
        let p = provider(&server, false, Some("bb_session=abc"));
        assert_eq!(p.search(&SearchQuery::text("x")).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn expired_cookie_without_credentials_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .respond_with(html(LOGGED_OUT))
            .mount(&server)
            .await;
        let p = provider(&server, false, Some("bb_session=old"));
        let err = p.search(&SearchQuery::text("x")).await.unwrap_err();
        assert!(matches!(err, ProviderError::Auth(m) if m.contains("expired")));
    }

    #[tokio::test]
    async fn logged_out_triggers_single_relogin() {
        let server = MockServer::start().await;
        // Первый поиск — «разлогин», после повторного входа — результаты.
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .respond_with(html(LOGGED_OUT))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .respond_with(html(SEARCH))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .respond_with(login_ok())
            .expect(2) // первичный вход + повторный
            .mount(&server)
            .await;
        let p = provider(&server, true, None);
        // Первичная сессия «есть» не будет: ensure_session логинится, затем разлогин → relogin.
        assert_eq!(p.search(&SearchQuery::text("x")).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn persistent_logout_gives_up_after_one_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/forum/tracker.php"))
            .respond_with(html(LOGGED_OUT))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/forum/login.php"))
            .respond_with(login_ok())
            .expect(2)
            .mount(&server)
            .await;
        let err = provider(&server, true, None)
            .search(&SearchQuery::text("x"))
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Auth(_)));
    }

    fn candidate() -> TorrentCandidate {
        TorrentCandidate {
            source: TorrentSource::Rutracker,
            source_topic_id: Some("5000001".into()),
            title: "Кино - Группа крови".into(),
            info_hash: None,
            magnet: None,
            download_url: None,
            size_bytes: None,
            seeders: None,
            leechers: None,
            category: None,
            files_count: None,
        }
    }

    #[tokio::test]
    async fn resolve_via_api_builds_magnet_with_rutracker_trackers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/get_tor_topic_data"))
            .and(query_param("by", "topic_id"))
            .and(query_param("val", "5000001"))
            .respond_with(ResponseTemplate::new(200).set_body_string(API))
            .expect(1)
            .mount(&server)
            .await;
        let r = provider(&server, false, None)
            .resolve(candidate())
            .await
            .unwrap();
        assert_eq!(
            r.info_hash.unwrap().as_str(),
            "0123456789abcdef0123456789abcdef01234567"
        );
        let m = r.magnet.unwrap();
        assert!(m.contains("bt.t-ru.org") && !m.contains("opentrackr"));
        assert_eq!(r.seeders, Some(42));
        assert_eq!(r.size_bytes, Some(512_345_678));
    }

    #[tokio::test]
    async fn resolve_falls_back_to_viewtopic() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/get_tor_topic_data"))
            .respond_with(ResponseTemplate::new(200).set_body_string(API_NULL))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forum/viewtopic.php"))
            .and(query_param("t", "5000001"))
            .respond_with(html(TOPIC))
            .expect(1)
            .mount(&server)
            .await;
        let r = provider(&server, false, Some("bb_session=abc"))
            .resolve(candidate())
            .await
            .unwrap();
        assert_eq!(
            r.info_hash.unwrap().as_str(),
            "abcdef0123456789abcdef0123456789abcdef01"
        );
        // Magnet со своим passkey остаётся как есть.
        assert!(r.magnet.unwrap().contains("pk%3Dsecret"));
    }

    #[tokio::test]
    async fn resolve_falls_back_when_api_is_down() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/get_tor_topic_data"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forum/viewtopic.php"))
            .respond_with(html(TOPIC))
            .mount(&server)
            .await;
        let r = provider(&server, false, Some("bb_session=abc"))
            .resolve(candidate())
            .await
            .unwrap();
        assert!(r.info_hash.is_some());
    }

    #[tokio::test]
    async fn unreachable_host_is_blocked_with_proxy_hint() {
        let p = RutrackerProvider::new(RutrackerOptions {
            base_url: Some("http://127.0.0.1:1/forum/".into()),
            cookie: Some("bb_session=x".into()),
            min_interval: Some(FAST),
            ..RutrackerOptions::default()
        })
        .unwrap();
        let err = p.search(&SearchQuery::text("x")).await.unwrap_err();
        assert!(matches!(err, ProviderError::Blocked(m) if m.contains("NIMBUS_RUTRACKER_PROXY")));
    }

    #[test]
    fn registry_registers_rutracker_with_creds_or_cookie() {
        let src = |extra: &[(&'static str, &'static str)]| -> Vec<TorrentSource> {
            let mut env = std::collections::HashMap::from([
                ("DATABASE_URL", "x"),
                ("NIMBUS_TPB_ENABLED", "false"),
            ]);
            env.extend(extra.iter().copied());
            ProviderRegistry::from_config(&Config::from_map(&env).unwrap())
                .unwrap()
                .sources()
        };
        assert!(src(&[]).is_empty());
        assert!(src(&[("NIMBUS_RUTRACKER_USERNAME", "u")]).is_empty());
        let both = [
            ("NIMBUS_RUTRACKER_USERNAME", "u"),
            ("NIMBUS_RUTRACKER_PASSWORD", "p"),
        ];
        assert_eq!(src(&both), [TorrentSource::Rutracker]);
        assert_eq!(
            src(&[("NIMBUS_RUTRACKER_COOKIE", "bb_session=1")]),
            [TorrentSource::Rutracker]
        );
    }

    #[tokio::test]
    #[ignore = "живой RuTracker: нужны NIMBUS_RUTRACKER_USERNAME/PASSWORD или COOKIE (и, возможно, PROXY)"]
    async fn live_rutracker_search_and_resolve() {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let p = RutrackerProvider::new(RutrackerOptions {
            username: env("NIMBUS_RUTRACKER_USERNAME"),
            password: env("NIMBUS_RUTRACKER_PASSWORD"),
            cookie: env("NIMBUS_RUTRACKER_COOKIE"),
            proxy: env("NIMBUS_RUTRACKER_PROXY"),
            ..RutrackerOptions::default()
        })
        .unwrap();
        let found = p
            .search(&SearchQuery::text("Кино Группа крови"))
            .await
            .unwrap();
        assert!(!found.is_empty());
        let r = p.resolve(found[0].clone()).await.unwrap();
        assert!(r.info_hash.is_some());
    }
}
