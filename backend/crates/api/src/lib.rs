pub mod acquisition;
pub mod artist_image;
pub mod audio_info;
pub mod auth;
pub mod download_manager;
pub mod downloads;
pub mod error;
pub mod extract;
#[cfg(feature = "test-fakes")]
pub mod fakes;
pub mod idle;
pub mod jobs;
pub mod library;
pub mod openapi;
pub mod playlists;
pub mod routes;
pub mod search;
pub mod settings;
pub mod sources;
pub mod state;
pub mod stream;
pub mod sync;
pub mod transcode;
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
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ))
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
        .allow_credentials(true)
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::RANGE])
        .expose_headers([
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_LENGTH,
            header::HeaderName::from_static(transcode::H_TRANSCODE),
            header::HeaderName::from_static(transcode::H_DURATION),
        ]);
    match HeaderValue::from_str(origin) {
        Ok(v) => layer.allow_origin(v),
        Err(_) => {
            tracing::warn!(origin, "invalid NIMBUS_CORS_ORIGIN, CORS disabled");
            layer
        }
    }
}
