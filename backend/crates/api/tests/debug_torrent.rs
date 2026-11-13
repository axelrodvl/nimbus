// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::sync::Arc;

use common::{post_json, router, state};
use nimbus_torrent::{EngineConfig, TorrentEngine};
use serde_json::json;
use sqlx::PgPool;

async fn local_engine(label: &str) -> (Arc<TorrentEngine>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("nimbus-api-{label}-{}", std::process::id()));
    let mut cfg = EngineConfig::new(&dir, false);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.metadata_timeout = std::time::Duration::from_millis(300);
    // Без DHT/трекеров/пиров librqbit отказывает сразу; нужен хотя бы (мёртвый) пир.
    cfg.initial_peers = vec![(std::net::Ipv4Addr::LOCALHOST, 9).into()];
    (Arc::new(TorrentEngine::new(cfg).await.unwrap()), dir)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn metadata_endpoint_without_engine_is_503(pool: PgPool) {
    let (status, v) = post_json(
        router(state(pool)),
        "/api/debug/torrent/metadata",
        json!({"magnet": "magnet:?xt=urn:btih:abababababababababababababababababababab"}),
    )
    .await;
    assert_eq!(status, 503);
    assert_eq!(v["error"]["code"], "engine_unavailable");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn metadata_endpoint_error_mapping(pool: PgPool) {
    let (engine, dir) = local_engine("meta").await;
    let app = router(state(pool).with_engine(engine));

    let (status, v) = post_json(
        app.clone(),
        "/api/debug/torrent/metadata",
        json!({"magnet": "http://example.org/not-a-magnet"}),
    )
    .await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (400, Some("invalid_magnet"))
    );

    // Пиров нет, DHT выключен — метаданные не придут.
    let (status, v) = post_json(
        app,
        "/api/debug/torrent/metadata",
        json!({"magnet": "magnet:?xt=urn:btih:abababababababababababababababababababab"}),
    )
    .await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (504, Some("metadata_timeout"))
    );
    let _ = std::fs::remove_dir_all(dir);
}
