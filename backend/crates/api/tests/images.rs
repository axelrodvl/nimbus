// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Дисковый кэш изображений: скачивается один раз, отдаётся с `immutable`, «нет картинки» запоминается.
mod common;

use axum::http::StatusCode;
use common::{get_json, router, state};
use http_body_util::BodyExt;
use nimbus_api::image_store;
use sqlx::PgPool;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000000000";

async fn serve(
    dir: &std::path::Path,
    name: &str,
    url: String,
) -> Result<axum::response::Response, nimbus_api::error::ApiError> {
    image_store::serve(dir, "NimbusTest/0.1", name, || async move { Ok(Some(url)) }).await
}

#[tokio::test]
async fn downloads_once_then_serves_from_disk_immutable() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a.png"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(PNG))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let url = format!("{}/a.png", server.uri());
    for _ in 0..2 {
        let res = serve(dir.path(), "cover-x", url.clone()).await.unwrap();
        assert_eq!(res.headers()["content-type"], "image/png");
        assert_eq!(
            res.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            res.into_body().collect().await.unwrap().to_bytes().as_ref(),
            PNG
        );
    }
    // Ожидание `.expect(1)` проверяется при drop сервера.
}

#[tokio::test]
async fn missing_and_non_images_are_remembered_not_refetched() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/none"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/html"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html></html>"))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    for (name, p) in [("a", "none"), ("b", "html")] {
        for _ in 0..2 {
            let err = serve(dir.path(), name, format!("{}/{p}", server.uri()))
                .await
                .unwrap_err();
            assert_eq!(err.status, StatusCode::NOT_FOUND);
        }
    }
}

#[tokio::test]
async fn upstream_error_is_not_remembered() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(503))
        .expect(2)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    for _ in 0..2 {
        let err = serve(dir.path(), "c", format!("{}/x", server.uri()))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_GATEWAY);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cover_endpoint_rejects_unknown_kind_and_size(pool: PgPool) {
    let id = "11111111-2222-3333-4444-555555555555";
    for uri in [
        format!("/api/covers/artist/{id}/250"),
        format!("/api/covers/release-group/{id}/1200"),
    ] {
        let (status, v) = get_json(router(state(pool.clone())), &uri).await;
        assert_eq!(status, 404, "{uri}");
        assert_eq!(v["error"]["code"], "no_image");
    }
}
