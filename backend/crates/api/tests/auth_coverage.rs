// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Каждый эндпоинт из OpenAPI при включённой авторизации без токена отвечает 401 —
//! кроме явного списка публичных. Новый эндпоинт без авторизации не пройдёт незамеченным.
mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use common::{router, state};
use nimbus_core::Config;
use sqlx::PgPool;
use tower::ServiceExt;

/// Публичные пути: проверка живости, спецификация, вход/выход/сессия, WebSocket
/// (авторизуется сам при рукопожатии).
fn is_public(path: &str) -> bool {
    path == "/api/health"
        || path == "/api/openapi.json"
        || path == "/api/ws"
        || path.starts_with("/api/auth/")
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn every_openapi_operation_requires_a_token_except_the_public_ones(pool: PgPool) {
    let mut st = state(pool);
    st.config = Arc::new(
        Config::from_map(&std::collections::HashMap::from([
            ("DATABASE_URL", "postgres://unused"),
            ("NIMBUS_API_TOKEN", "s3cret-token"),
        ]))
        .unwrap(),
    );
    let app = router(st);
    let spec = serde_json::to_value(nimbus_api::openapi::openapi()).unwrap();
    let paths = spec["paths"].as_object().unwrap();
    assert!(
        paths.len() > 30,
        "спецификация подозрительно мала: {}",
        paths.len()
    );

    let (mut checked, mut public) = (0, 0);
    for (path, item) in paths {
        let uri = path
            .split('/')
            .map(|seg| if seg.starts_with('{') { "1" } else { seg })
            .collect::<Vec<_>>()
            .join("/");
        for method in ["get", "post", "put", "patch", "delete"] {
            if item.get(method).is_none() {
                continue;
            }
            let req = Request::builder()
                .method(method.to_uppercase().as_str())
                .uri(&uri)
                .body(Body::empty())
                .unwrap();
            let status = app.clone().oneshot(req).await.unwrap().status().as_u16();
            if is_public(path) {
                public += 1;
                assert_ne!(status, 401, "{method} {path} должен быть публичным");
            } else {
                checked += 1;
                assert_eq!(status, 401, "{method} {path} доступен без токена");
            }
        }
    }
    assert!(
        checked > 40,
        "проверено мало операций: {checked} (публичных {public})"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn the_public_list_does_not_hide_a_private_endpoint(_pool: PgPool) {
    // Охранный тест списка: префикс `/api/auth/` не должен случайно покрывать чужие пути.
    for p in ["/api/authors", "/api/library", "/api/settings", "/api/ws2"] {
        assert!(!is_public(p), "{p}");
    }
}
