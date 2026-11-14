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

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn performance_defaults_are_exposed(pool: PgPool) {
    let (_, body) = get_json(router(state(pool)), "/api/settings").await;
    assert_eq!(
        body["performance"],
        json!({
            "discover_workers": 8, "verify_workers": 16, "import_workers": 2,
            "metadata_concurrency": 16, "metadata_timeout_secs": 30, "download_concurrency": 4
        })
    );
    assert_eq!(body["storage"]["auto_download"], "off");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn download_settings_are_validated(pool: PgPool) {
    let app = router(state(pool));
    for bad in [0, 33] {
        let (code, body) = put(
            app.clone(),
            json!({"performance": {"download_concurrency": bad}}),
        )
        .await;
        assert_eq!(code, 400, "{bad}");
        assert_eq!(body["error"]["code"], "invalid_settings");
    }
    let (code, _) = put(app.clone(), json!({"storage": {"auto_download": "always"}})).await;
    assert_eq!(code, 400);
    let (code, body) = put(app, json!({"storage": {"auto_download": "added"}})).await;
    assert_eq!(code, 200);
    assert_eq!(body["storage"]["auto_download"], "added");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn performance_is_validated(pool: PgPool) {
    let app = router(state(pool));
    for bad in [0, 65, 200] {
        let (code, body) = put(app.clone(), json!({"performance": {"verify_workers": bad}})).await;
        assert_eq!(code, 400, "{bad}: {body}");
        assert_eq!(body["error"]["code"], "invalid_settings");
    }
    let (code, _) = put(app.clone(), json!({"performance": {"verify_workers": -1}})).await;
    assert_eq!(code, 400, "отрицательное не помещается в u8");
    let (code, _) = put(app.clone(), json!({"performance": {"import_workers": 64}})).await;
    assert_eq!(code, 200);
    // Метаданные торрентов: concurrency 1..=64, timeout 5..=300 с.
    for (field, bad) in [
        ("metadata_concurrency", 0),
        ("metadata_concurrency", 65),
        ("metadata_timeout_secs", 4),
        ("metadata_timeout_secs", 301),
    ] {
        let (code, body) = put(app.clone(), json!({"performance": {field: bad}})).await;
        assert_eq!(code, 400, "{field}={bad}: {body}");
        assert_eq!(body["error"]["code"], "invalid_settings");
    }
    let (code, body) = put(
        app,
        json!({"performance": {"metadata_concurrency": 64, "metadata_timeout_secs": 300}}),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(body["performance"]["metadata_concurrency"], 64);
    assert_eq!(body["performance"]["metadata_timeout_secs"], 300);
    assert_eq!(body["restart_required"], true);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn restart_required_only_when_performance_changes(pool: PgPool) {
    let app = router(state(pool));
    let (_, body) = put(app.clone(), json!({"storage": {"cache_limit_gb": 7}})).await;
    assert_eq!(body["restart_required"], false);
    let (_, body) = put(app.clone(), json!({"performance": {"discover_workers": 4}})).await;
    assert_eq!(body["restart_required"], true);
    assert_eq!(body["performance"]["discover_workers"], 4);
    // Пока процесс работает со старыми значениями, посторонние сохранения флаг не сбрасывают.
    let (_, body) = put(app.clone(), json!({"storage": {"cache_limit_gb": 8}})).await;
    assert_eq!(body["restart_required"], true);
    // Вернули стартовое значение — перезапуск не нужен.
    let (_, body) = put(app, json!({"performance": {"discover_workers": 8}})).await;
    assert_eq!(body["restart_required"], false);
}

// ------------------------------------------------------------------ MusicBrainz (шаг 30)

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn musicbrainz_defaults_are_exposed_and_validated(pool: PgPool) {
    let app = router(state(pool));
    let (_, body) = get_json(app.clone(), "/api/settings").await;
    assert_eq!(
        body["musicbrainz"]["base_url"],
        "https://musicbrainz.org/ws/2/"
    );
    assert_eq!(body["musicbrainz"]["rate_per_sec"], 1.0);
    assert_eq!(body["musicbrainz"]["burst"], 3);
    assert_eq!(body["musicbrainz"]["max_concurrent"], 2);
    for bad in [
        json!({"base_url": "ftp://x/"}),
        json!({"base_url": "http://mirror"}),
        json!({"rate_per_sec": 500.0}),
        json!({"burst": 0}),
        json!({"max_concurrent": 33}),
    ] {
        let (code, body) = put(app.clone(), json!({"musicbrainz": bad})).await;
        assert_eq!(code, 400, "{bad}");
        assert_eq!(body["error"]["code"], "invalid_settings");
    }
    let (_, body) = get_json(app, "/api/settings").await;
    assert_eq!(
        body["musicbrainz"]["burst"], 3,
        "некорректное не сохранилось"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn musicbrainz_settings_apply_on_the_fly(pool: PgPool) {
    let mirror = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ws/2/artist"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"artists": []})))
        .mount(&mirror)
        .await;
    let st = state(pool); // MB по умолчанию смотрит в никуда (порт 9)
    let app = router(st.clone());
    assert!(st.mb.search_artists("radiohead", 5).await.is_err());

    // Адрес зеркала (профиль зеркала: без лимита) — следующий запрос идёт уже туда.
    let (code, body) = put(
        app.clone(),
        json!({"musicbrainz": {"base_url": format!("{}/ws/2/", mirror.uri())}}),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert!(st
        .mb
        .search_artists("radiohead", 5)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(mirror.received_requests().await.unwrap().len(), 1);

    // Посторонние настройки MusicBrainz не трогают.
    let (code, _) = put(app, json!({"storage": {"cache_limit_gb": 9}})).await;
    assert_eq!(code, 200);
    assert!(st.mb.search_artists("radiohead again", 5).await.is_ok());
    assert_eq!(mirror.received_requests().await.unwrap().len(), 2);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn validation_error_names_the_field(pool: PgPool) {
    let app = router(state(pool));
    let (code, body) = put(
        app.clone(),
        json!({"performance": {"download_concurrency": 0}}),
    )
    .await;
    assert_eq!(code, 400);
    assert_eq!(body["error"]["field"], "performance.download_concurrency");
    // Сообщение без пути поля — без `field`.
    let (code, body) = put(app, json!({"storage": {"cache_limit_gb": "x"}})).await;
    assert_eq!(code, 400);
    assert!(body["error"].get("field").is_none(), "{body}");
}
