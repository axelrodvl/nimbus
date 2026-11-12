#![cfg(feature = "test-fakes")]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{get_json, request_json, router, state};
use nimbus_torrent::fake_swarm;
use nimbus_torrent::{EngineConfig, TorrentEngine};
use sqlx::PgPool;

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn downloads_without_engine_is_503(pool: PgPool) {
    let (status, v) = get_json(router(state(pool)), "/api/downloads").await;
    assert_eq!(status, 503);
    assert_eq!(v["error"]["code"], "engine_unavailable");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn list_pause_resume(pool: PgPool) {
    let root = std::env::temp_dir().join(format!("nimbus-api-downloads-{}", std::process::id()));
    let swarm = fake_swarm::start(
        &root.join("swarm"),
        "Album",
        &[("01.flac".to_string(), vec![7u8; 200_000])],
    )
    .await
    .unwrap();
    let mut cfg = EngineConfig::new(root.join("engine"), true);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.initial_peers = vec![swarm.addr];
    let engine = Arc::new(TorrentEngine::new(cfg).await.unwrap());
    let app = router(state(pool).with_engine(engine.clone()));

    let (status, v) = get_json(app.clone(), "/api/downloads").await;
    assert_eq!(
        (status, v["torrents"].as_array().map(Vec::len)),
        (200, Some(0))
    );

    engine.ensure_file(&swarm.magnet, 0).await.unwrap();
    // Ждём завершения: торрент остаётся раздающим (seeding = true).
    let mut seeding = false;
    for _ in 0..100 {
        let (_, v) = get_json(app.clone(), "/api/downloads").await;
        if v["torrents"][0]["state"] == "seeding" {
            assert_eq!(v["torrents"][0]["info_hash"], swarm.info_hash);
            assert_eq!(v["torrents"][0]["name"], "Album");
            seeding = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(seeding, "torrent did not reach seeding state");

    let base = format!("/api/downloads/{}", swarm.info_hash);
    let (status, _) = request_json(app.clone(), "POST", &format!("{base}/pause"), None).await;
    assert_eq!(status, 204);
    let (_, v) = get_json(app.clone(), "/api/downloads").await;
    assert_eq!(v["torrents"][0]["state"], "paused");
    // Идемпотентно.
    let (status, _) = request_json(app.clone(), "POST", &format!("{base}/pause"), None).await;
    assert_eq!(status, 204);

    let (status, _) = request_json(app.clone(), "POST", &format!("{base}/resume"), None).await;
    assert_eq!(status, 204);
    let (_, v) = get_json(app.clone(), "/api/downloads").await;
    assert_ne!(v["torrents"][0]["state"], "paused");

    let (status, v) = request_json(
        app.clone(),
        "POST",
        "/api/downloads/abababababababababababababababababababab/pause",
        None,
    )
    .await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (404, Some("not_found"))
    );
    let (status, v) = request_json(app, "POST", "/api/downloads/nope/pause", None).await;
    assert_eq!(
        (status, v["error"]["code"].as_str()),
        (400, Some("invalid_info_hash"))
    );

    engine.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}
