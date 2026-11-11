use utoipa::OpenApi;

use crate::{routes, search};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Nimbus API",
        description = "Бэкенд веб-плеера Nimbus: метаданные MusicBrainz, музыка из торрентов."
    ),
    paths(routes::health, routes::debug_jobs, routes::ws_doc, search::search),
    components(schemas(
        routes::HealthResponse,
        crate::error::ErrorResponse,
        crate::error::ErrorBody,
        search::SearchResponse,
        search::ArtistResult,
        search::AlbumResult,
        search::TrackResult,
        nimbus_core::model::TrackStatus,
    )),
    tags(
        (name = "system", description = "Служебные эндпоинты"),
        (name = "search", description = "Поиск в MusicBrainz"),
    )
)]
pub struct ApiDoc;

/// Спецификация OpenAPI (также печатается `nimbus --print-openapi`).
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut doc = ApiDoc::openapi();
    doc.info.version = env!("CARGO_PKG_VERSION").to_string();
    doc.info.license = None;
    doc
}
