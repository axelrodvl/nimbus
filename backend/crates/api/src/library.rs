//! Эндпоинты библиотеки: добавление/удаление, списки, страницы артиста и альбома.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, SecondsFormat, Utc};
use nimbus_core::model::TrackStatus;
use nimbus_db::repo::jobs::{ImportPhase, ImportProgress};
use nimbus_db::repo::views::{self, AlbumView, ArtistView, Cursor, TrackView};
use nimbus_library::{AddOutcome, LibraryError, LibraryType};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::error::{ApiError, ErrorResponse};
use crate::extract::ApiJson;
use crate::state::AppState;

const DEFAULT_PAGE: i64 = 50;
const DEFAULT_TRACK_PAGE: i64 = 100;
const MAX_PAGE: i64 = 200;

impl From<LibraryError> for ApiError {
    fn from(e: LibraryError) -> Self {
        match e {
            LibraryError::MbNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                "mb_not_found",
                "not found in MusicBrainz",
            ),
            LibraryError::MbUnavailable(reason) => {
                tracing::warn!(%reason, "MusicBrainz unavailable");
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "mb_unavailable",
                    "MusicBrainz is unavailable",
                )
            }
            LibraryError::RecordingNotInRelease => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "recording_not_in_release",
                "the recording is not part of the album tracklist",
            ),
            LibraryError::NotFound(what) => ApiError::not_found(format!("{what} not found")),
            LibraryError::Db(e) => e.into(),
        }
    }
}

// ------------------------------------------------------------------ DTO

#[derive(Debug, Serialize, ToSchema)]
pub struct StatusCounts {
    pub adding: i64,
    pub found: i64,
    pub not_found: i64,
    pub ready: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArtistDto {
    pub id: i64,
    pub mbid: Uuid,
    pub name: String,
    pub disambiguation: Option<String>,
    pub in_library: bool,
    /// Альбомы артиста, в которых хоть что-то в библиотеке.
    pub album_count: i64,
    /// Треки артиста в библиотеке.
    pub track_count: i64,
    /// Состояние импорта дискографии; `null`, если импорт завершён или не запускался.
    pub import: Option<ImportStatusDto>,
    /// Когда добавлен в библиотеку (для сортировки «Недавно добавлено»).
    pub added_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportState {
    /// Импорт идёт или ждёт своей очереди.
    Importing,
    /// Попытка не удалась (обычно MusicBrainz недоступен), будет повтор.
    Retrying,
    /// Попытки исчерпаны: нужен ручной повтор.
    Failed,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportStatusDto {
    pub state: ImportState,
    /// Сколько попыток уже начато.
    pub attempt: i32,
    pub max_attempts: i32,
    /// Когда будет следующая попытка (только `retrying`).
    pub retry_at: Option<DateTime<Utc>>,
    /// Причина последней неудачи (для подсказки; текст от бэкенда, на английском).
    pub error: Option<String>,
    /// Подробный прогресс текущей попытки (`null`, пока задача не начала работу).
    pub progress: Option<ImportProgressDto>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportPhaseDto {
    /// Запрашиваем список альбомов у MusicBrainz.
    Groups,
    /// Добавляем альбомы по одному.
    Albums,
    /// Альбомы добавлены, ставим поиск источников.
    Discover,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportProgressDto {
    pub phase: ImportPhaseDto,
    /// Обработано release group'ов (добавлено + пропущено).
    pub done: u32,
    pub total: u32,
    /// Альбом, который обрабатывается сейчас.
    pub current: Option<String>,
    pub imported: u32,
    pub skipped: u32,
    /// Журнал шагов (старые первыми; текст на английском).
    pub log: Vec<ImportLogEntryDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportLogEntryDto {
    pub at: DateTime<Utc>,
    pub text: String,
}

fn import_progress(a: &ArtistView) -> Option<ImportProgressDto> {
    let p: ImportProgress = serde_json::from_value(a.import_progress.clone()?).ok()?;
    Some(ImportProgressDto {
        phase: match p.phase {
            ImportPhase::Groups => ImportPhaseDto::Groups,
            ImportPhase::Albums => ImportPhaseDto::Albums,
            ImportPhase::Discover => ImportPhaseDto::Discover,
        },
        done: p.done,
        total: p.total,
        current: p.current,
        imported: p.imported,
        skipped: p.skipped,
        log: p
            .log
            .into_iter()
            .map(|e| ImportLogEntryDto {
                at: e.at,
                text: e.text,
            })
            .collect(),
    })
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AlbumDto {
    pub id: i64,
    /// MBID release group.
    pub mbid: Uuid,
    pub title: String,
    pub artist_id: i64,
    pub artist_name: String,
    pub year: Option<i32>,
    pub primary_type: Option<String>,
    pub cover_url: Option<String>,
    /// Альбом добавлен целиком.
    pub in_library: bool,
    /// Все треки альбома (не только добавленные в библиотеку).
    pub track_count: i64,
    /// Последнее добавление альбома или его трека (сортировка «Недавно добавлено»).
    pub added_at: Option<DateTime<Utc>>,
    pub status_counts: StatusCounts,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TrackDto {
    pub id: i64,
    pub mbid_recording: Uuid,
    pub title: String,
    pub album_id: i64,
    pub album_title: String,
    pub artist_id: i64,
    pub artist_name: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
    pub cover_url: Option<String>,
    pub status: TrackStatus,
    pub status_reason: Option<String>,
    pub in_library: bool,
    /// Primary-источник трека сомнительный: его стоит проверить или подтвердить.
    pub needs_confirmation: bool,
    /// Как играть: `direct` — файл отдаётся с Range, `transcode` — перекодируется на лету (без Range, перемотка через `?t=`).
    pub playback: PlaybackMode,
    /// Сколько раз трек прослушан.
    pub play_count: i32,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackMode {
    Direct,
    Transcode,
}

fn import_status(a: &ArtistView) -> Option<ImportStatusDto> {
    let attempt = a.import_attempts.unwrap_or(0);
    let state = match (a.import_state.as_deref()?, attempt) {
        ("running", _) | ("queued", 0) => ImportState::Importing,
        ("queued", _) => ImportState::Retrying,
        ("failed", _) => ImportState::Failed,
        _ => return None,
    };
    Some(ImportStatusDto {
        attempt,
        error: a
            .import_error
            .clone()
            .filter(|_| state != ImportState::Importing || attempt > 1),
        max_attempts: a.import_max_attempts.unwrap_or(0),
        retry_at: (state == ImportState::Retrying)
            .then_some(a.import_run_after)
            .flatten(),
        progress: import_progress(a),
        state,
    })
}

impl From<ArtistView> for ArtistDto {
    fn from(a: ArtistView) -> Self {
        let import = import_status(&a);
        Self {
            import,
            id: a.id,
            mbid: a.mbid,
            name: a.name,
            disambiguation: a.disambiguation,
            in_library: a.in_library,
            album_count: a.album_count,
            track_count: a.track_count,
            added_at: a.added_at,
        }
    }
}

impl From<AlbumView> for AlbumDto {
    fn from(a: AlbumView) -> Self {
        Self {
            id: a.id,
            mbid: a.mbid,
            title: a.title,
            artist_id: a.artist_id,
            artist_name: a.artist_name,
            year: a.year,
            primary_type: a.primary_type,
            cover_url: a.cover_url,
            in_library: a.in_library,
            track_count: a.track_count,
            added_at: a.added_at,
            status_counts: StatusCounts {
                adding: a.adding,
                found: a.found,
                not_found: a.not_found,
                ready: a.ready,
            },
        }
    }
}

impl From<TrackView> for TrackDto {
    fn from(t: TrackView) -> Self {
        Self {
            id: t.id,
            mbid_recording: t.mbid_recording,
            title: t.title,
            album_id: t.album_id,
            album_title: t.album_title,
            artist_id: t.artist_id,
            artist_name: t.artist_name,
            disc_no: t.disc_no,
            position: t.position,
            duration_ms: t.duration_ms,
            cover_url: t.cover_url,
            status: t.status,
            status_reason: t.status_reason,
            in_library: t.in_library,
            needs_confirmation: t.needs_confirmation,
            play_count: t.play_count,
            playback: if t.transcode {
                PlaybackMode::Transcode
            } else {
                PlaybackMode::Direct
            },
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArtistPage {
    pub items: Vec<ArtistDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AlbumPage {
    pub items: Vec<AlbumDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TrackPage {
    pub items: Vec<TrackDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArtistDetailDto {
    pub artist: ArtistDto,
    /// Альбомы, в которых хоть что-то в библиотеке.
    pub albums: Vec<AlbumDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AlbumDetailDto {
    pub album: AlbumDto,
    pub artist: ArtistDto,
    /// Все треки альбома с флагом `in_library`.
    pub tracks: Vec<TrackDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    Artist,
    Album,
    Track,
}

impl From<LibraryKind> for LibraryType {
    fn from(k: LibraryKind) -> Self {
        match k {
            LibraryKind::Artist => LibraryType::Artist,
            LibraryKind::Album => LibraryType::Album,
            LibraryKind::Track => LibraryType::Track,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddToLibraryRequest {
    /// `artist`, `album` (MBID release group) или `track` (MBID recording).
    #[serde(rename = "type")]
    #[schema(rename = "type")]
    pub kind: LibraryKind,
    pub mbid: Uuid,
    /// Для `track`: MBID release group альбома (иначе определяется по MusicBrainz).
    #[serde(default)]
    pub album_mbid: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddStatus {
    Added,
    Importing,
    Exists,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AddToLibraryResponse {
    #[serde(rename = "type")]
    #[schema(rename = "type")]
    pub kind: LibraryKind,
    pub id: i64,
    pub status: AddStatus,
}

// ------------------------------------------------------------------ курсоры

fn encode_cursor((at, id): Cursor) -> String {
    format!("{}|{id}", at.to_rfc3339_opts(SecondsFormat::Micros, true))
}

fn decode_cursor(raw: Option<&str>) -> Result<Option<Cursor>, ApiError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let bad = || ApiError::bad_request("bad_cursor", "invalid cursor");
    let (at, id) = raw.split_once('|').ok_or_else(bad)?;
    let at = DateTime::parse_from_rfc3339(at)
        .map_err(|_| bad())?
        .with_timezone(&Utc);
    Ok(Some((at, id.parse().map_err(|_| bad())?)))
}

fn page_limit(limit: Option<i64>, default: i64) -> Result<i64, ApiError> {
    let limit = limit.unwrap_or(default);
    if (1..=MAX_PAGE).contains(&limit) {
        Ok(limit)
    } else {
        Err(ApiError::bad_request(
            "bad_limit",
            format!("limit must be 1..{MAX_PAGE}"),
        ))
    }
}

/// Делит `limit + 1` записей на страницу и курсор следующей.
fn paginate<T, V>(
    mut rows: Vec<V>,
    limit: i64,
    key: impl Fn(&V) -> Option<Cursor>,
    map: impl Fn(V) -> T,
) -> (Vec<T>, Option<String>) {
    let next = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().and_then(&key).map(encode_cursor)
    } else {
        None
    };
    (rows.into_iter().map(map).collect(), next)
}

// ------------------------------------------------------------------ хендлеры

#[utoipa::path(
    post,
    path = "/api/library",
    tag = "library",
    request_body = AddToLibraryRequest,
    responses(
        (status = 201, description = "Альбом или трек добавлен", body = AddToLibraryResponse),
        (status = 202, description = "Артист добавлен, дискография импортируется в фоне", body = AddToLibraryResponse),
        (status = 200, description = "Уже в библиотеке", body = AddToLibraryResponse),
        (status = 400, description = "Некорректный запрос", body = ErrorResponse),
        (status = 404, description = "MBID не найден в MusicBrainz (mb_not_found)", body = ErrorResponse),
        (status = 422, description = "Запись не входит в треклист альбома (recording_not_in_release)", body = ErrorResponse),
        (status = 503, description = "MusicBrainz недоступен (mb_unavailable)", body = ErrorResponse),
    )
)]
pub async fn add_to_library(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<AddToLibraryRequest>,
) -> Result<Response, ApiError> {
    let svc = &state.library;
    let outcome = match req.kind {
        LibraryKind::Artist => svc.add_artist(req.mbid).await?,
        LibraryKind::Album => svc.add_album(req.mbid).await?,
        LibraryKind::Track => svc.add_track(req.mbid, req.album_mbid).await?,
    };
    let (status, add_status, id) = match outcome {
        AddOutcome::Added { id } => (StatusCode::CREATED, AddStatus::Added, id),
        AddOutcome::Importing { id } => (StatusCode::ACCEPTED, AddStatus::Importing, id),
        AddOutcome::Exists { id } => (StatusCode::OK, AddStatus::Exists, id),
    };
    Ok((
        status,
        Json(AddToLibraryResponse {
            kind: req.kind,
            id,
            status: add_status,
        }),
    )
        .into_response())
}

#[utoipa::path(
    delete,
    path = "/api/library/{type}/{id}",
    tag = "library",
    params(
        ("type" = String, Path, description = "artist, album или track"),
        ("id" = i64, Path, description = "id в нашей БД"),
    ),
    responses(
        (status = 204, description = "Убрано из библиотеки (метаданные сохранены)"),
        (status = 400, description = "Неверный type", body = ErrorResponse),
        (status = 404, description = "Не найдено", body = ErrorResponse),
    )
)]
pub async fn remove_from_library(
    State(state): State<AppState>,
    Path((ty, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    let ty: LibraryType = ty
        .parse()
        .map_err(|_| ApiError::bad_request("bad_type", "type must be artist, album or track"))?;
    state.library.remove(ty, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_statuses(raw: Option<&str>) -> Result<Vec<TrackStatus>, ApiError> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.split(',')
                .map(|part| {
                    part.trim().parse::<TrackStatus>().map_err(|_| {
                        ApiError::bad_request(
                            "bad_status",
                            "status must be a comma-separated list of adding, found, not_found, ready",
                        )
                    })
                })
                .collect()
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PageParams {
    /// Курсор из `next_cursor` предыдущей страницы.
    cursor: Option<String>,
    /// 1..200, по умолчанию 50 (для треков — 100).
    limit: Option<i64>,
    /// Фильтр по статусам треков через запятую: adding, found, not_found, ready (например `found,ready`).
    status: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/library/artists",
    tag = "library",
    params(PageParams),
    responses((status = 200, body = ArtistPage), (status = 400, body = ErrorResponse))
)]
pub async fn list_artists(
    State(state): State<AppState>,
    Query(p): Query<PageParams>,
) -> Result<Json<ArtistPage>, ApiError> {
    let limit = page_limit(p.limit, DEFAULT_PAGE)?;
    let cursor = decode_cursor(p.cursor.as_deref())?;
    let statuses = parse_statuses(p.status.as_deref())?;
    let rows = views::list_artists(&state.db, &statuses, cursor, limit + 1).await?;
    let (items, next_cursor) = paginate(
        rows,
        limit,
        |r| views::next_cursor(r.added_at, r.id),
        ArtistDto::from,
    );
    Ok(Json(ArtistPage { items, next_cursor }))
}

#[utoipa::path(
    get,
    path = "/api/library/albums",
    tag = "library",
    params(PageParams),
    responses((status = 200, body = AlbumPage), (status = 400, body = ErrorResponse))
)]
pub async fn list_albums(
    State(state): State<AppState>,
    Query(p): Query<PageParams>,
) -> Result<Json<AlbumPage>, ApiError> {
    let limit = page_limit(p.limit, DEFAULT_PAGE)?;
    let cursor = decode_cursor(p.cursor.as_deref())?;
    let statuses = parse_statuses(p.status.as_deref())?;
    let rows = views::list_albums(&state.db, &statuses, cursor, limit + 1).await?;
    let (items, next_cursor) = paginate(
        rows,
        limit,
        |r| views::next_cursor(r.added_at, r.id),
        AlbumDto::from,
    );
    Ok(Json(AlbumPage { items, next_cursor }))
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct RecentlyPlayedParams {
    limit: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/library/albums/recently-played",
    tag = "library",
    params(RecentlyPlayedParams),
    responses((status = 200, body = AlbumPage), (status = 400, body = ErrorResponse))
)]
pub async fn recently_played_albums(
    State(state): State<AppState>,
    Query(p): Query<RecentlyPlayedParams>,
) -> Result<Json<AlbumPage>, ApiError> {
    let limit = page_limit(p.limit, DEFAULT_PAGE)?;
    let rows = views::recently_played_albums(&state.db, limit).await?;
    Ok(Json(AlbumPage {
        items: rows.into_iter().map(AlbumDto::from).collect(),
        next_cursor: None,
    }))
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TrackPageParams {
    /// Фильтр по статусам через запятую: adding, found, not_found, ready (например `found,ready`).
    status: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/library/tracks",
    tag = "library",
    params(TrackPageParams),
    responses((status = 200, body = TrackPage), (status = 400, body = ErrorResponse))
)]
pub async fn list_tracks(
    State(state): State<AppState>,
    Query(p): Query<TrackPageParams>,
) -> Result<Json<TrackPage>, ApiError> {
    let limit = page_limit(p.limit, DEFAULT_TRACK_PAGE)?;
    let cursor = decode_cursor(p.cursor.as_deref())?;
    let statuses = parse_statuses(p.status.as_deref())?;
    let rows = views::list_tracks(&state.db, &statuses, cursor, limit + 1).await?;
    let (items, next_cursor) = paginate(
        rows,
        limit,
        |r| views::next_cursor(r.added_at, r.id),
        TrackDto::from,
    );
    Ok(Json(TrackPage { items, next_cursor }))
}

#[utoipa::path(
    get,
    path = "/api/artists/{id}",
    tag = "library",
    params(("id" = i64, Path)),
    responses((status = 200, body = ArtistDetailDto), (status = 404, body = ErrorResponse))
)]
pub async fn get_artist(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArtistDetailDto>, ApiError> {
    let artist = views::get_artist(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("artist not found"))?;
    let albums = views::albums_for_artist(&state.db, id).await?;
    Ok(Json(ArtistDetailDto {
        artist: artist.into(),
        albums: albums.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/artists/{id}/import",
    tag = "library",
    params(("id" = i64, Path)),
    responses(
        (status = 202, description = "Импорт дискографии поставлен в очередь (или уже идёт)"),
        (status = 404, body = ErrorResponse),
    )
)]
pub async fn retry_artist_import(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let artist = views::get_artist(&state.db, id)
        .await?
        .filter(|a| a.in_library)
        .ok_or_else(|| ApiError::not_found("artist not found in the library"))?;
    state.library.enqueue_import(artist.id).await?;
    state
        .events
        .publish(nimbus_core::events::Event::LibraryChanged {
            entity: nimbus_core::events::Entity::Artist,
            id: artist.id,
        });
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(
    get,
    path = "/api/albums/{id}",
    tag = "library",
    params(("id" = i64, Path)),
    responses((status = 200, body = AlbumDetailDto), (status = 404, body = ErrorResponse))
)]
pub async fn get_album(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<AlbumDetailDto>, ApiError> {
    let album = views::get_album(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("album not found"))?;
    let artist = views::get_artist(&state.db, album.artist_id)
        .await?
        .ok_or_else(|| ApiError::not_found("artist not found"))?;
    let tracks = views::tracks_for_album(&state.db, id).await?;
    Ok(Json(AlbumDetailDto {
        album: album.into(),
        artist: artist.into(),
        tracks: tracks.into_iter().map(Into::into).collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/api/tracks/{id}",
    tag = "library",
    params(("id" = i64, Path)),
    responses((status = 200, body = TrackDto), (status = 404, body = ErrorResponse))
)]
pub async fn get_track(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<TrackDto>, ApiError> {
    let track = views::get_track(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    Ok(Json(track.into()))
}
