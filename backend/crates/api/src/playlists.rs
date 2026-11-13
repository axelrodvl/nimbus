//! Плейлисты, динамический плейлист Favorites (Топ-100 по прослушиваниям) и счётчик прослушиваний.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use nimbus_db::repo::playlists::{self, PlaylistRow, FAVORITES_LIMIT};
use nimbus_db::repo::views;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::{ApiError, ErrorResponse};
use crate::extract::ApiJson;
use crate::library::TrackDto;
use crate::state::AppState;

const MAX_NAME_CHARS: usize = 100;
/// Идентификатор динамического плейлиста в путях и ссылках.
pub const FAVORITES_SLUG: &str = "favorites";

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistKind {
    /// Обычный плейлист: треки добавляет пользователь.
    User,
    /// Динамический Favorites: Топ-100 прослушиваемых треков, вручную не редактируется.
    Favorites,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlaylistDto {
    /// `favorites` или числовой ID плейлиста (строкой) — подходит для пути `/api/playlists/{id}`.
    pub id: String,
    pub kind: PlaylistKind,
    pub name: String,
    pub track_count: i64,
    pub cover_url: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    /// Последнее добавление трека.
    pub last_used_at: Option<DateTime<Utc>>,
}

impl From<PlaylistRow> for PlaylistDto {
    fn from(p: PlaylistRow) -> Self {
        Self {
            id: p.id.to_string(),
            kind: PlaylistKind::User,
            name: p.name,
            track_count: p.track_count,
            cover_url: p.cover_url,
            created_at: Some(p.created_at),
            last_used_at: Some(p.last_used_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlaylistList {
    /// Favorites идёт первым, затем плейлисты пользователя: недавно использованные — выше.
    pub items: Vec<PlaylistDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlaylistDetail {
    pub playlist: PlaylistDto,
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreatePlaylistRequest {
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddTrackRequest {
    pub track_id: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlayCountResponse {
    pub play_count: i32,
}

async fn favorites_dto(state: &AppState) -> Result<PlaylistDto, ApiError> {
    Ok(PlaylistDto {
        id: FAVORITES_SLUG.into(),
        kind: PlaylistKind::Favorites,
        name: "Favorites".into(),
        track_count: playlists::favorites_count(&state.db).await?,
        cover_url: playlists::favorites_cover(&state.db).await?,
        created_at: None,
        last_used_at: None,
    })
}

#[utoipa::path(
    post,
    path = "/api/tracks/{id}/played",
    tag = "playlists",
    params(("id" = i64, Path, description = "ID трека")),
    responses((status = 200, body = PlayCountResponse), (status = 404, body = ErrorResponse))
)]
/// Засчитывает прослушивание трека (плеер зовёт, когда прослушана заметная часть).
pub async fn record_play(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<PlayCountResponse>, ApiError> {
    let play_count = playlists::record_play(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    Ok(Json(PlayCountResponse { play_count }))
}

#[utoipa::path(
    get,
    path = "/api/playlists",
    tag = "playlists",
    responses((status = 200, body = PlaylistList))
)]
pub async fn list_playlists(State(state): State<AppState>) -> Result<Json<PlaylistList>, ApiError> {
    let mut items = vec![favorites_dto(&state).await?];
    items.extend(
        playlists::list(&state.db)
            .await?
            .into_iter()
            .map(Into::into),
    );
    Ok(Json(PlaylistList { items }))
}

#[utoipa::path(
    post,
    path = "/api/playlists",
    tag = "playlists",
    request_body = CreatePlaylistRequest,
    responses((status = 201, body = PlaylistDto), (status = 400, body = ErrorResponse))
)]
pub async fn create_playlist(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreatePlaylistRequest>,
) -> Result<(StatusCode, Json<PlaylistDto>), ApiError> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError::bad_request(
            "bad_name",
            format!("playlist name must be 1..{MAX_NAME_CHARS} characters"),
        ));
    }
    let id = playlists::create(&state.db, name).await?;
    let row = playlists::get(&state.db, id)
        .await?
        .ok_or_else(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// ID пути: `favorites` или число.
enum PlaylistRef {
    Favorites,
    User(i64),
}

fn parse_ref(id: &str) -> Result<PlaylistRef, ApiError> {
    if id == FAVORITES_SLUG {
        return Ok(PlaylistRef::Favorites);
    }
    id.parse()
        .map(PlaylistRef::User)
        .map_err(|_| ApiError::not_found("playlist not found"))
}

fn user_playlist(id: &str) -> Result<i64, ApiError> {
    match parse_ref(id)? {
        PlaylistRef::User(id) => Ok(id),
        PlaylistRef::Favorites => Err(ApiError::new(
            StatusCode::CONFLICT,
            "playlist_dynamic",
            "Favorites is built automatically from play counts",
        )),
    }
}

#[utoipa::path(
    get,
    path = "/api/playlists/{id}",
    tag = "playlists",
    params(("id" = String, Path, description = "`favorites` или ID плейлиста")),
    responses((status = 200, body = PlaylistDetail), (status = 404, body = ErrorResponse))
)]
pub async fn get_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PlaylistDetail>, ApiError> {
    let (playlist, tracks) = match parse_ref(&id)? {
        PlaylistRef::Favorites => (
            favorites_dto(&state).await?,
            views::favorite_tracks(&state.db, FAVORITES_LIMIT).await?,
        ),
        PlaylistRef::User(id) => (
            playlists::get(&state.db, id)
                .await?
                .ok_or_else(|| ApiError::not_found("playlist not found"))?
                .into(),
            views::playlist_tracks(&state.db, id).await?,
        ),
    };
    Ok(Json(PlaylistDetail {
        playlist,
        tracks: tracks.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    delete,
    path = "/api/playlists/{id}",
    tag = "playlists",
    params(("id" = String, Path)),
    responses(
        (status = 204),
        (status = 404, body = ErrorResponse),
        (status = 409, description = "Favorites удалить нельзя", body = ErrorResponse),
    )
)]
pub async fn delete_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if playlists::delete(&state.db, user_playlist(&id)?).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("playlist not found"))
    }
}

#[utoipa::path(
    post,
    path = "/api/playlists/{id}/tracks",
    tag = "playlists",
    params(("id" = String, Path)),
    request_body = AddTrackRequest,
    responses(
        (status = 204, description = "Трек добавлен (повторное добавление — без дубля), плейлист поднят в списке"),
        (status = 404, body = ErrorResponse),
        (status = 409, description = "В Favorites вручную не добавляют", body = ErrorResponse),
    )
)]
pub async fn add_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<AddTrackRequest>,
) -> Result<StatusCode, ApiError> {
    if playlists::add_track(&state.db, user_playlist(&id)?, req.track_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("playlist or track not found"))
    }
}

#[utoipa::path(
    delete,
    path = "/api/playlists/{id}/tracks/{track_id}",
    tag = "playlists",
    params(("id" = String, Path), ("track_id" = i64, Path)),
    responses(
        (status = 204),
        (status = 404, body = ErrorResponse),
        (status = 409, body = ErrorResponse),
    )
)]
pub async fn remove_track(
    State(state): State<AppState>,
    Path((id, track_id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    if playlists::remove_track(&state.db, user_playlist(&id)?, track_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("track is not in the playlist"))
    }
}
