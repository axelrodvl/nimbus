// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{get_json, post_json, request_json, router, state};
use nimbus_core::model::TorrentSource;
use nimbus_db::settings::SettingsStore;
use serde_json::json;
use sqlx::PgPool;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const MASK: &str = "••••";

async fn put(app: axum::Router, body: serde_json::Value) -> (u16, serde_json::Value) {
    request_json(app, "PUT", "/api/settings", Some(body)).await
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn get_returns_defaults_without_secrets(pool: PgPool) {
    let app = router(state(pool));
    let (code, body) = get_json(app, "/api/settings").await;
    assert_eq!(code, 200);
    assert_eq!(body["providers"]["tpb_enabled"], true);
    assert_eq!(body["storage"]["cache_limit_gb"], 50);
    assert_eq!(body["matching"]["accept"].as_f64(), Some(0.8));
    assert!(body["providers"]["torznab"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn put_merges_masks_secrets_and_persists(pool: PgPool) {
    let st = state(pool.clone());
    let app = router(st.clone());

    let (code, body) = put(
        app.clone(),
        json!({
            "providers": {"rutracker": {"username": "bob", "password": "hunter2", "cookie": "bb_session=abc"}},
            "storage": {"cache_limit_gb": 3, "seeding": true},
        }),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["providers"]["rutracker"]["username"], "bob");
    assert_eq!(body["providers"]["rutracker"]["password"], MASK);
    assert_eq!(body["providers"]["rutracker"]["cookie"], MASK);
    assert!(!body.to_string().contains("hunter2"));
    assert_eq!(body["storage"]["cache_limit_gb"], 3);
    // Нетронутые разделы на месте.
    assert_eq!(body["providers"]["tpb_enabled"], true);

    // Пустой секрет и маска не затирают сохранённое; другие поля меняются.
    let (code, body) = put(
        app.clone(),
        json!({"providers": {"rutracker": {"username": "alice", "password": "", "cookie": MASK}}}),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(body["providers"]["rutracker"]["username"], "alice");
    assert_eq!(body["providers"]["rutracker"]["password"], MASK);
    let stored = st.settings.get();
    let r = stored.providers.rutracker.as_ref().unwrap();
    assert_eq!(r.password.as_deref(), Some("hunter2"));
    assert_eq!(r.cookie.as_deref(), Some("bb_session=abc"));

    // Сохранено в БД: новое хранилище читает то же самое поверх дефолтов.
    let reloaded = SettingsStore::load(pool, nimbus_core::Settings::default())
        .await
        .unwrap()
        .get();
    assert_eq!(reloaded.storage.cache_limit_gb, 3);
    assert!(reloaded.storage.seeding);
    assert_eq!(
        reloaded
            .providers
            .rutracker
            .as_ref()
            .unwrap()
            .password
            .as_deref(),
        Some("hunter2")
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invalid_settings_are_rejected_and_not_saved(pool: PgPool) {
    let st = state(pool);
    let app = router(st.clone());
    for bad in [
        json!({"matching": {"accept": 0.4, "confirm": 0.9}}),
        json!({"storage": {"cache_limit_gb": 0}}),
        json!({"search": {"format_prefs": ["nope"]}}),
        json!({"storage": {"cache_limit_gb": "x"}}),
        json!([]),
    ] {
        let (code, body) = put(app.clone(), bad.clone()).await;
        assert_eq!(code, 400, "{bad}");
        assert!(body["error"]["code"].is_string());
    }
    assert_eq!(st.settings.get().storage.cache_limit_gb, 50);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changing_providers_rebuilds_the_registry(pool: PgPool) {
    let st = state(pool);
    let app = router(st.clone());
    assert!(st.providers.sources().is_empty());

    let (code, _) = put(app.clone(), json!({"providers": {"tpb_enabled": true}})).await;
    assert_eq!(code, 200);
    assert_eq!(st.providers.sources(), [TorrentSource::Tpb]);

    let (code, _) = put(
        app.clone(),
        json!({"providers": {"torznab": {"url": "http://tz.example", "api_key": "k"}}}),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(
        st.providers.sources(),
        [TorrentSource::Tpb, TorrentSource::Torznab]
    );

    let (code, _) = put(
        app,
        json!({"providers": {"tpb_enabled": false, "torznab": null}}),
    )
    .await;
    assert_eq!(code, 200);
    assert!(st.providers.sources().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn provider_test_reports_results_and_missing_config(pool: PgPool) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            include_str!("../../trackers/tests/fixtures/torznab_music.xml"),
            "application/xml",
        ))
        .mount(&server)
        .await;
    let app = router(state(pool));

    // Не настроен → 400.
    let (code, body) = post_json(
        app.clone(),
        "/api/settings/providers/test",
        json!({"provider": "rutracker"}),
    )
    .await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (400, Some("not_configured"))
    );
    let (code, _) = post_json(
        app.clone(),
        "/api/settings/providers/test",
        json!({"provider": "torznab"}),
    )
    .await;
    assert_eq!(code, 400);

    let (code, _) = put(
        app.clone(),
        json!({"providers": {"tpb_enabled": false, "torznab": {"url": server.uri(), "api_key": "KEY"}}}),
    )
    .await;
    assert_eq!(code, 200);
    let (code, body) = post_json(
        app.clone(),
        "/api/settings/providers/test",
        json!({"provider": "torznab"}),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["ok"], true);
    assert!(body["sample_count"].as_u64().unwrap() > 0);

    // Провайдер отвечает ошибкой → ok = false, а не 5xx.
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/api"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let (code, body) = post_json(
        app,
        "/api/settings/providers/test",
        json!({"provider": "torznab"}),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(body["ok"], false);
    assert!(!body["message"].as_str().unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn storage_reports_usage_and_limit(pool: PgPool) {
    use nimbus_core::model::*;
    use nimbus_db::repo::{downloads, torrents};
    let t = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&"cd".repeat(20)).unwrap(),
            magnet: format!("magnet:?xt=urn:btih:{}", "cd".repeat(20)),
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
    let file = std::env::temp_dir().join(format!("nimbus-storage-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&file, vec![1u8; 1000]).unwrap();
    downloads::upsert(
        &pool,
        &NewDownload {
            torrent_id: t.id,
            file_index: 0,
            local_path: file.to_string_lossy().into_owned(),
            bytes_total: 1000,
            bytes_done: 500,
        },
    )
    .await
    .unwrap();
    let app = router(state(pool));
    put(app.clone(), json!({"storage": {"cache_limit_gb": 2}})).await;
    let (code, body) = get_json(app, "/api/storage").await;
    assert_eq!(code, 200);
    assert_eq!(body["used_bytes"], 1000);
    assert_eq!(body["limit_bytes"], 2u64 * 1024 * 1024 * 1024);
    assert_eq!(
        (body["files"].as_i64(), body["torrents_active"].as_i64()),
        (Some(1), Some(1))
    );
    let _ = std::fs::remove_file(&file);
}
