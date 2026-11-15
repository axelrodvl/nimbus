// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{get_json, router, state};
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_ok(pool: PgPool) {
    let (status, v) = get_json(router(state(pool)), "/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(v["status"], "ok");
    assert_eq!(v["db"], true);
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cors_header_for_configured_origin(pool: PgPool) {
    let res = router(state(pool))
        .oneshot(
            Request::get("/api/health")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "http://localhost:3000"
    );
}

struct Down;

#[async_trait::async_trait]
impl nimbus_trackers::TorrentProvider for Down {
    fn source(&self) -> nimbus_core::model::TorrentSource {
        nimbus_core::model::TorrentSource::Tpb
    }
    async fn search(
        &self,
        _q: &nimbus_trackers::SearchQuery,
    ) -> Result<Vec<nimbus_trackers::TorrentCandidate>, nimbus_trackers::ProviderError> {
        Err(nimbus_trackers::ProviderError::Blocked("HTTP 503".into()))
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_lists_providers_and_their_breaker_state(pool: PgPool) {
    let registry = std::sync::Arc::new(nimbus_trackers::ProviderRegistry::new(vec![
        std::sync::Arc::new(Down),
    ]));
    let st = state(pool).with_providers(registry.clone());

    let (_, v) = get_json(router(st.clone()), "/api/health").await;
    assert_eq!(v["providers"][0]["source"], "tpb");
    assert_eq!(v["providers"][0]["state"], "ok");
    assert!(v["providers"][0]["last_error"].is_null());
    assert!(v["providers"][0]["open_until"].is_null());

    for i in 0..3 {
        registry
            .search_all(&nimbus_trackers::SearchQuery::text(format!("q{i}")))
            .await;
    }
    let (status, v) = get_json(router(st), "/api/health").await;
    assert_eq!(status, 200);
    let p = &v["providers"][0];
    assert_eq!(p["state"], "open");
    assert!(p["last_error"].as_str().unwrap().contains("503"));
    assert!(p["open_until"].as_str().is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_without_providers_has_empty_list(pool: PgPool) {
    let (_, v) = get_json(router(state(pool)), "/api/health").await;
    assert_eq!(v["providers"], serde_json::json!([]));
}
