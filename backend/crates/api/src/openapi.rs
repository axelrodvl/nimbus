use utoipa::OpenApi;

use crate::{library, routes, search};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Nimbus API",
        description = "Бэкенд веб-плеера Nimbus: метаданные MusicBrainz, музыка из торрентов."
    ),
    paths(
        routes::health,
        routes::debug_jobs,
        routes::debug_torrent_metadata,
        routes::ws_doc,
        search::search,
        library::add_to_library,
        library::remove_from_library,
        library::list_artists,
        library::list_albums,
        library::list_tracks,
        library::get_artist,
        library::get_album,
        library::get_track,
    ),
    components(schemas(
        routes::HealthResponse,
        routes::DebugMetadataRequest,
        crate::error::ErrorResponse,
        crate::error::ErrorBody,
        search::SearchResponse,
        search::ArtistResult,
        search::AlbumResult,
        search::TrackResult,
        library::StatusCounts,
        library::ArtistDto,
        library::AlbumDto,
        library::TrackDto,
        library::ArtistPage,
        library::AlbumPage,
        library::TrackPage,
        library::ArtistDetailDto,
        library::AlbumDetailDto,
        library::LibraryKind,
        library::AddToLibraryRequest,
        library::AddStatus,
        library::AddToLibraryResponse,
        nimbus_core::model::TrackStatus,
    )),
    tags(
        (name = "system", description = "Служебные эндпоинты"),
        (name = "search", description = "Поиск в MusicBrainz"),
        (name = "library", description = "Библиотека: добавление, списки, страницы артиста и альбома"),
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
