//! Каталог MusicBrainz для экранов поиска: дискография артиста и треклист альбома, которых может
//! ещё не быть в библиотеке (`GET /api/catalog/artists/{mbid}`, `GET /api/catalog/albums/{mbid}`).
//! Ответы MusicBrainz кэшируются клиентом (`mb_cache`), повторный заход — без сети. `POST /api/play` — сыграть
//! трек или альбом из каталога, не добавляя в библиотеку.

use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::Json;
use nimbus_core::model::TrackStatus;
use nimbus_db::repo::{albums, artists, tracks};
use nimbus_library::LibraryError;
use nimbus_musicbrainz::{cover_url, MbError, ReleaseGroupHit};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::error::ApiError;
use crate::extract::ApiJson;
use crate::search::AlbumResult;
use crate::state::AppState;

const COVER_SIZE: u16 = 250;
/// Типы групп в дискографии — как у импорта артиста.
const DISCOGRAPHY_TYPES: &[&str] = &["album", "ep"];
/// Дискография — несколько страниц MusicBrainz под лимитом 1 запрос/с: дольше поиска.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogArtist {
    pub mbid: Uuid,
    pub name: String,
    pub disambiguation: Option<String>,
    pub country: Option<String>,
    /// `id` в нашей БД, если артист добавлен в библиотеку.
    pub library_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogArtistResponse {
    pub artist: CatalogArtist,
    /// Альбомы и EP артиста: новые сверху, без года — в конце.
    pub albums: Vec<AlbumResult>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogTrack {
    /// MBID записи (recording) — его принимает `POST /api/library` с `type=track`.
    pub mbid: Uuid,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<u32>,
    /// `id` трека в библиотеке, если он добавлен.
    pub library_id: Option<i64>,
    pub status: Option<TrackStatus>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogAlbumResponse {
    pub album: AlbumResult,
    /// Треклист каноничного релиза группы (тот же, что получит альбом при добавлении).
    pub tracks: Vec<CatalogTrack>,
}

fn parse_mbid(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::bad_request("bad_mbid", "mbid must be a UUID"))
}

/// Запрос к MusicBrainz с общим таймаутом; ошибки — как у добавления в библиотеку
/// (`mb_not_found` → 404, остальное → 503 `mb_unavailable`).
async fn mb_call<T>(fut: impl Future<Output = Result<T, MbError>>) -> Result<T, ApiError> {
    match tokio::time::timeout(CATALOG_TIMEOUT, fut).await {
        Ok(r) => r.map_err(|e| LibraryError::from(e).into()),
        Err(_) => Err(LibraryError::MbUnavailable("timeout".into()).into()),
    }
}

fn album_result(a: ReleaseGroupHit, library_id: Option<i64>) -> AlbumResult {
    AlbumResult {
        library_id,
        cover_url: cover_url(a.mbid, COVER_SIZE),
        mbid: a.mbid,
        title: a.title,
        artist_mbid: a.artist_mbid,
        artist_name: a.artist_name,
        primary_type: a.primary_type,
        secondary_types: a.secondary_types,
        year: a.year,
        score: a.score,
    }
}

#[utoipa::path(
    get,
    path = "/api/catalog/artists/{mbid}",
    tag = "search",
    params(("mbid" = String, Path, description = "MBID артиста")),
    responses(
        (status = 200, description = "Артист и его альбомы из MusicBrainz", body = CatalogArtistResponse),
        (status = 400, description = "mbid — не UUID (bad_mbid)", body = crate::error::ErrorResponse),
        (status = 404, description = "Нет в MusicBrainz (mb_not_found)", body = crate::error::ErrorResponse),
        (status = 503, description = "MusicBrainz недоступен (mb_unavailable)", body = crate::error::ErrorResponse),
    )
)]
pub async fn catalog_artist(
    State(state): State<AppState>,
    Path(mbid): Path<String>,
) -> Result<Json<CatalogArtistResponse>, ApiError> {
    let mbid = parse_mbid(&mbid)?;
    let (artist, groups) = tokio::try_join!(
        mb_call(state.mb.artist(mbid)),
        mb_call(state.mb.artist_release_groups(mbid, DISCOGRAPHY_TYPES)),
    )?;
    // Совместные релизы, где первым указан другой артист, — не его дискография (как у импорта).
    let mut groups: Vec<_> = groups
        .into_iter()
        .filter(|g| g.artist_mbid == mbid)
        .collect();
    groups.sort_by(|a, b| {
        b.year
            .is_some()
            .cmp(&a.year.is_some())
            .then(b.year.cmp(&a.year))
            .then_with(|| a.title.cmp(&b.title))
    });
    let artist_id = artists::library_ids_by_mbid(&state.db, &[mbid])
        .await?
        .first()
        .map(|r| r.1);
    let ids: Vec<Uuid> = groups.iter().map(|g| g.mbid).collect();
    let album_ids: HashMap<Uuid, i64> = albums::library_ids_by_rg_mbid(&state.db, &ids)
        .await?
        .into_iter()
        .collect();
    Ok(Json(CatalogArtistResponse {
        artist: CatalogArtist {
            mbid: artist.mbid,
            name: artist.name,
            disambiguation: artist.disambiguation,
            country: artist.country,
            library_id: artist_id,
        },
        albums: groups
            .into_iter()
            .map(|g| {
                let id = album_ids.get(&g.mbid).copied();
                album_result(g, id)
            })
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/api/catalog/albums/{mbid}",
    tag = "search",
    params(("mbid" = String, Path, description = "MBID группы релизов (альбома)")),
    responses(
        (status = 200, description = "Альбом и его треклист из MusicBrainz", body = CatalogAlbumResponse),
        (status = 400, description = "mbid — не UUID (bad_mbid)", body = crate::error::ErrorResponse),
        (status = 404, description = "Нет в MusicBrainz (mb_not_found)", body = crate::error::ErrorResponse),
        (status = 503, description = "MusicBrainz недоступен (mb_unavailable)", body = crate::error::ErrorResponse),
    )
)]
pub async fn catalog_album(
    State(state): State<AppState>,
    Path(mbid): Path<String>,
) -> Result<Json<CatalogAlbumResponse>, ApiError> {
    let mbid = parse_mbid(&mbid)?;
    let (group, (_release, tracklist)) = tokio::try_join!(
        mb_call(state.mb.release_group(mbid)),
        mb_call(state.mb.canonical_release_with_tracklist(mbid)),
    )?;
    let album_id = albums::library_ids_by_rg_mbid(&state.db, &[mbid])
        .await?
        .first()
        .map(|r| r.1);
    let recordings: Vec<Uuid> = tracklist.tracks.iter().map(|t| t.mbid_recording).collect();
    let info: HashMap<Uuid, (i64, TrackStatus)> =
        tracks::library_info_by_recording(&state.db, &recordings)
            .await?
            .into_iter()
            .map(|(rec, id, status, _album)| (rec, (id, status)))
            .collect();
    Ok(Json(CatalogAlbumResponse {
        album: album_result(group, album_id),
        tracks: tracklist
            .tracks
            .into_iter()
            .map(|t| {
                let own = info.get(&t.mbid_recording);
                CatalogTrack {
                    mbid: t.mbid_recording,
                    title: t.title,
                    disc_no: t.disc_no,
                    position: t.position,
                    duration_ms: t.duration_ms,
                    library_id: own.map(|o| o.0),
                    status: own.map(|o| o.1),
                }
            })
            .collect(),
    }))
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlayKind {
    Album,
    Track,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PlayRequest {
    /// `track` (MBID recording) или `album` (MBID release group — все треки альбома).
    #[serde(rename = "type")]
    #[schema(rename = "type")]
    pub kind: PlayKind,
    pub mbid: Uuid,
    /// Для `track`: MBID release group альбома (иначе определяется по MusicBrainz).
    #[serde(default)]
    pub album_mbid: Option<Uuid>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlayResponse {
    pub album_id: i64,
    /// Запрошенные треки в порядке треклиста; их статусы приходят синхронизацией.
    pub track_ids: Vec<i64>,
}

#[utoipa::path(
    post,
    path = "/api/play",
    tag = "search",
    request_body = PlayRequest,
    responses(
        (status = 200, description = "Треки запрошены для прослушивания (в библиотеку не добавлены); источник ищется", body = PlayResponse),
        (status = 400, description = "Некорректный запрос", body = crate::error::ErrorResponse),
        (status = 404, description = "MBID не найден в MusicBrainz (mb_not_found)", body = crate::error::ErrorResponse),
        (status = 422, description = "Запись не входит в треклист альбома (recording_not_in_release)", body = crate::error::ErrorResponse),
        (status = 503, description = "MusicBrainz недоступен (mb_unavailable)", body = crate::error::ErrorResponse),
    )
)]
pub async fn play(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<PlayRequest>,
) -> Result<Json<PlayResponse>, ApiError> {
    let outcome = match req.kind {
        PlayKind::Track => state.library.play_track(req.mbid, req.album_mbid).await?,
        PlayKind::Album => state.library.play_album(req.mbid).await?,
    };
    Ok(Json(PlayResponse {
        album_id: outcome.album_id,
        track_ids: outcome.track_ids,
    }))
}
