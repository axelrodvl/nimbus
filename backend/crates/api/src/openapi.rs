use utoipa::OpenApi;

use crate::{library, routes, search, sources};

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
        routes::debug_album_torrents,
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
        crate::stream::stream_track,
        sources::album_torrents_list,
        sources::torrent_files,
        sources::track_sources_list,
        sources::set_source,
        sources::confirm_source,
        sources::retry_track,
        sources::retry_album,
        sources::add_magnet,
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
        library::PlaybackMode,
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
        nimbus_core::model::TorrentSource,
        nimbus_core::model::TorrentKind,
        nimbus_core::model::MetaStatus,
        sources::TorrentDto,
        sources::AlbumTorrentDto,
        sources::TorrentFileDto,
        sources::TrackSourceDto,
        sources::SetSourceRequest,
        sources::AddMagnetRequest,
        sources::AddMagnetResponse,
        sources::RetryResponse,
    )),
    tags(
        (name = "system", description = "Служебные эндпоинты"),
        (name = "search", description = "Поиск в MusicBrainz"),
        (name = "sources", description = "Источники: раздачи, файлы, ручной выбор, retry"),
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
