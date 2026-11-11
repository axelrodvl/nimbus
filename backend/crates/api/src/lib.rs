pub mod auth;
pub mod error;
pub mod extract;
pub mod library;
pub mod openapi;
pub mod routes;
pub mod search;
pub mod state;
pub mod stream;
pub mod ws;

use axum::http::{header, HeaderValue, Method};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use state::AppState;

/// Полный роутер приложения.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api", routes::api_routes(&state))
        .layer(cors_layer(&state.config.cors_origin))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn cors_layer(origin: &str) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::RANGE])
        .expose_headers([
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_LENGTH,
        ]);
    match HeaderValue::from_str(origin) {
        Ok(v) => layer.allow_origin(v),
        Err(_) => {
            tracing::warn!(origin, "invalid NIMBUS_CORS_ORIGIN, CORS disabled");
            layer
        }
    }
}
