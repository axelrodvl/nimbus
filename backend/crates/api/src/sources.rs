//! Источники: раздачи альбома, файлы раздач, источники трека, ручной выбор, свой magnet, retry.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use nimbus_core::events::{Entity, Event};
use nimbus_core::jobs::{Job, PRIORITY_INTERACTIVE};
use nimbus_core::model::{
    InfoHash, MetaStatus, NewTorrent, TorrentKind, TorrentSource, TrackSource, TrackStatus,
};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::jobs::EnqueueOpts;
use nimbus_db::repo::{album_torrents, albums, downloads, jobs, torrents, track_sources, tracks};
use nimbus_library::retry::{self as library_retry, queue_search, RetryOptions};
use nimbus_torrent::TorrentHandleId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::auth::authorize;
use crate::error::{ApiError, ErrorResponse};
use crate::extract::ApiJson;
use crate::state::AppState;

// ------------------------------------------------------------------ DTO

#[derive(Debug, Serialize, ToSchema)]
pub struct TorrentDto {
    pub id: i64,
    pub info_hash: String,
    pub source: TorrentSource,
    pub title: String,
    pub size_bytes: Option<i64>,
    pub seeders: Option<i32>,
    pub leechers: Option<i32>,
    pub kind: TorrentKind,
    pub meta_status: MetaStatus,
}

impl From<&nimbus_core::model::Torrent> for TorrentDto {
    fn from(t: &nimbus_core::model::Torrent) -> Self {
        Self {
            id: t.id,
            info_hash: t.info_hash.clone(),
            source: t.source,
            title: t.title.clone(),
            size_bytes: t.size_bytes,
            seeders: t.seeders,
            leechers: t.leechers,
            kind: t.kind,
            meta_status: t.meta_status,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AlbumTorrentDto {
    pub torrent: TorrentDto,
    pub rank_score: f32,
    pub verified: bool,
    /// Сколько треков альбома сопоставлено с файлами этой раздачи.
    pub matched_tracks: i64,
    pub files_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TorrentFileDto {
    pub file_index: i32,
    pub path: String,
    pub size_bytes: i64,
    pub ext: Option<String>,
    pub matched_track_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TrackSourceDto {
    pub id: i64,
    pub torrent: TorrentDto,
    pub file_index: i32,
    pub path: String,
    pub size_bytes: i64,
    pub match_score: f32,
    pub is_primary: bool,
    pub needs_confirmation: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetSourceRequest {
    /// Существующий источник трека.
    pub source_id: Option<i64>,
    /// Либо пара «раздача + файл» (источник создаётся с `match_score = 1.0`).
    pub torrent_id: Option<i64>,
    pub file_index: Option<i32>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddMagnetRequest {
    pub magnet: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RetryResponse {
    /// Была ли поставлена новая задача (`false` — такая уже в очереди).
    pub queued: bool,
    /// Сколько треков переведено в `adding`.
    pub tracks_reset: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AddMagnetResponse {
    pub torrent: TorrentDto,
    pub queued: bool,
}

fn not_found(what: &str) -> ApiError {
    ApiError::not_found(format!("{what} not found"))
}

async fn source_dto(state: &AppState, s: &TrackSource) -> Result<TrackSourceDto, ApiError> {
    let torrent = torrents::get(&state.db, s.torrent_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let file = torrents::files(&state.db, s.torrent_id)
        .await?
        .into_iter()
        .find(|f| f.file_index == s.file_index);
    Ok(TrackSourceDto {
        id: s.id,
        torrent: TorrentDto::from(&torrent),
        file_index: s.file_index,
        path: file.as_ref().map(|f| f.path.clone()).unwrap_or_default(),
        size_bytes: file.map(|f| f.size_bytes).unwrap_or(0),
        match_score: s.match_score,
        is_primary: s.is_primary,
        needs_confirmation: s.needs_confirmation,
    })
}

fn track_changed(state: &AppState, track_id: i64) {
    state.events.publish(Event::LibraryChanged {
        entity: Entity::Track,
        id: track_id,
    });
}

// ------------------------------------------------------------------ чтение

#[utoipa::path(
    get,
    path = "/api/albums/{id}/torrents",
    tag = "sources",
    params(("id" = i64, Path, description = "ID альбома")),
    responses(
        (status = 200, description = "Раздачи альбома по убыванию ранга", body = Vec<AlbumTorrentDto>),
        (status = 404, description = "Нет такого альбома", body = ErrorResponse),
    )
)]
pub async fn album_torrents_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Vec<AlbumTorrentDto>>, ApiError> {
    authorize(&state, &headers)?;
    albums::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("album"))?;
    let rows = album_torrents::list_with_counts(&state.db, id).await?;
    Ok(Json(
        rows.iter()
            .map(|r| AlbumTorrentDto {
                torrent: TorrentDto::from(&r.torrent),
                rank_score: r.rank_score,
                verified: r.verified,
                matched_tracks: r.matched_tracks,
                files_count: r.files_count,
            })
            .collect(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/torrents/{id}/files",
    tag = "sources",
    params(("id" = i64, Path, description = "ID раздачи")),
    responses(
        (status = 200, description = "Файлы раздачи (пусто, пока метаданные не получены)", body = Vec<TorrentFileDto>),
        (status = 404, description = "Нет такой раздачи", body = ErrorResponse),
    )
)]
pub async fn torrent_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Vec<TorrentFileDto>>, ApiError> {
    authorize(&state, &headers)?;
    torrents::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("torrent"))?;
    let rows = torrents::files_with_match(&state.db, id).await?;
    Ok(Json(
        rows.into_iter()
            .map(|f| TorrentFileDto {
                file_index: f.file_index,
                path: f.path,
                size_bytes: f.size_bytes,
                ext: f.ext,
                matched_track_id: f.matched_track_id,
            })
            .collect(),
    ))
}

#[utoipa::path(
    get,
    path = "/api/tracks/{id}/sources",
    tag = "sources",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 200, description = "Источники трека: primary первым, затем по `match_score`", body = Vec<TrackSourceDto>),
        (status = 404, description = "Нет такого трека", body = ErrorResponse),
    )
)]
pub async fn track_sources_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Vec<TrackSourceDto>>, ApiError> {
    authorize(&state, &headers)?;
    tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("track"))?;
    let mut out = Vec::new();
    for s in track_sources::list_for_track(&state.db, id).await? {
        out.push(source_dto(&state, &s).await?);
    }
    Ok(Json(out))
}

// ------------------------------------------------------------------ выбор источника

#[utoipa::path(
    put,
    path = "/api/tracks/{id}/source",
    tag = "sources",
    params(("id" = i64, Path, description = "ID трека")),
    request_body = SetSourceRequest,
    responses(
        (status = 200, description = "Новый primary-источник", body = TrackSourceDto),
        (status = 400, description = "Нужен либо `source_id`, либо `torrent_id` + `file_index`", body = ErrorResponse),
        (status = 404, description = "Нет трека, источника или файла", body = ErrorResponse),
    )
)]
pub async fn set_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    ApiJson(req): ApiJson<SetSourceRequest>,
) -> Result<Json<TrackSourceDto>, ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("track"))?;
    let old_primary = track_sources::primary_for_track(&state.db, id).await?;

    let source = match (req.source_id, req.torrent_id, req.file_index) {
        (Some(source_id), None, None) => track_sources::get(&state.db, source_id)
            .await?
            .filter(|s| s.track_id == id)
            .ok_or_else(|| not_found("source"))?,
        (None, Some(torrent_id), Some(file_index)) => {
            if let Some(s) = track_sources::find_pair(&state.db, id, torrent_id, file_index).await?
            {
                s
            } else {
                let exists = torrents::files(&state.db, torrent_id)
                    .await?
                    .iter()
                    .any(|f| f.file_index == file_index);
                if !exists {
                    return Err(not_found("torrent file"));
                }
                track_sources::insert(
                    &state.db,
                    &nimbus_core::model::NewTrackSource {
                        track_id: id,
                        torrent_id,
                        file_index,
                        match_score: 1.0,
                        needs_confirmation: false,
                        cue_start_ms: None,
                        cue_end_ms: None,
                    },
                )
                .await?
            }
        }
        _ => {
            return Err(ApiError::bad_request(
                "bad_source",
                "pass either `source_id` or `torrent_id` with `file_index`",
            ))
        }
    };

    let source = track_sources::set_primary(&state.db, id, source.id)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => not_found("source"),
            e => e.into(),
        })?;

    // Статус: файл уже скачан → ready, иначе found (из not_found/adding/ready).
    let complete = downloads::get(&state.db, source.torrent_id, source.file_index)
        .await?
        .is_some_and(|d| d.completed_at.is_some());
    let target = if complete {
        TrackStatus::Ready
    } else {
        TrackStatus::Found
    };
    if track.status != target {
        set_track_status_and_publish(&state.db, &state.events, id, target, None).await?;
    }
    track_changed(&state, id);

    if let Some(old) = old_primary.filter(|o| o.id != source.id) {
        release_unneeded(&state, &old).await;
    }
    Ok(Json(source_dto(&state, &source).await?))
}

/// Старый файл качается и больше никому не нужен — снимаем с загрузки (данные не удаляем:
/// их вытеснит кэш, шаг 22).
pub(crate) async fn release_unneeded(state: &AppState, old: &TrackSource) {
    let Some(files) = state.files.as_ref() else {
        return;
    };
    let in_progress = matches!(
        downloads::get(&state.db, old.torrent_id, old.file_index).await,
        Ok(Some(d)) if d.completed_at.is_none()
    );
    if !in_progress {
        return;
    }
    match track_sources::track_ids_with_primary(&state.db, old.torrent_id, old.file_index).await {
        Ok(users) if users.is_empty() => {}
        _ => return,
    }
    let Ok(Some(t)) = torrents::get(&state.db, old.torrent_id).await else {
        return;
    };
    let Ok(hash) = InfoHash::parse(&t.info_hash) else {
        return;
    };
    if let Err(e) = files
        .release_file(&TorrentHandleId(hash), old.file_index as usize, false)
        .await
    {
        tracing::debug!(error = %e, torrent_id = old.torrent_id, "release_file failed");
    }
}

#[utoipa::path(
    post,
    path = "/api/tracks/{id}/sources/{source_id}/confirm",
    tag = "sources",
    params(
        ("id" = i64, Path, description = "ID трека"),
        ("source_id" = i64, Path, description = "ID источника"),
    ),
    responses(
        (status = 200, description = "Источник подтверждён", body = TrackSourceDto),
        (status = 404, description = "Нет такого источника у трека", body = ErrorResponse),
    )
)]
pub async fn confirm_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, source_id)): Path<(i64, i64)>,
) -> Result<Json<TrackSourceDto>, ApiError> {
    authorize(&state, &headers)?;
    let s = track_sources::confirm(&state.db, id, source_id)
        .await?
        .ok_or_else(|| not_found("source"))?;
    track_changed(&state, id);
    Ok(Json(source_dto(&state, &s).await?))
}

// ------------------------------------------------------------------ retry

#[utoipa::path(
    post,
    path = "/api/tracks/{id}/retry",
    tag = "sources",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 202, description = "Трек → `adding`, поиск раздач поставлен в очередь", body = RetryResponse),
        (status = 404, description = "Нет такого трека", body = ErrorResponse),
        (status = 409, description = "Трек уже `ready` (`track_ready`)", body = ErrorResponse),
    )
)]
pub async fn retry_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<(StatusCode, Json<RetryResponse>), ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("track"))?;
    if track.status == TrackStatus::Ready {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "track_ready",
            "track is already downloaded",
        ));
    }
    let mut reset = 0;
    if track.status != TrackStatus::Adding {
        set_track_status_and_publish(&state.db, &state.events, id, TrackStatus::Adding, None)
            .await?;
        reset = 1;
    }
    let queued = queue_search(&state.db, track.album_id, PRIORITY_INTERACTIVE, true).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(RetryResponse {
            queued,
            tracks_reset: reset,
        }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/albums/{id}/retry",
    tag = "sources",
    params(("id" = i64, Path, description = "ID альбома")),
    responses(
        (status = 202, description = "Треки `not_found` → `adding`, поиск запущен заново", body = RetryResponse),
        (status = 404, description = "Нет такого альбома", body = ErrorResponse),
    )
)]
pub async fn retry_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<(StatusCode, Json<RetryResponse>), ApiError> {
    authorize(&state, &headers)?;
    albums::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("album"))?;
    let report = library_retry::retry_album(
        &state.db,
        &state.events,
        id,
        RetryOptions {
            priority: PRIORITY_INTERACTIVE,
            reset_dead: false,
            manual: true,
        },
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(RetryResponse {
            queued: report.queued,
            tracks_reset: report.tracks_reset as i64,
        }),
    ))
}

// ------------------------------------------------------------------ свой magnet

/// Значение параметра `dn=` magnet-ссылки (с декодированием `%XX` и `+`).
fn magnet_display_name(magnet: &str) -> Option<String> {
    let query = magnet.strip_prefix("magnet:?")?;
    let raw = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| k.eq_ignore_ascii_case("dn"))?
        .1;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    let s = String::from_utf8_lossy(&out).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[utoipa::path(
    post,
    path = "/api/albums/{id}/torrents",
    tag = "sources",
    params(("id" = i64, Path, description = "ID альбома")),
    request_body = AddMagnetRequest,
    responses(
        (status = 202, description = "Раздача добавлена, проверка поставлена в очередь", body = AddMagnetResponse),
        (status = 400, description = "Некорректный magnet (`invalid_magnet`)", body = ErrorResponse),
        (status = 404, description = "Нет такого альбома", body = ErrorResponse),
    )
)]
pub async fn add_magnet(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    ApiJson(req): ApiJson<AddMagnetRequest>,
) -> Result<(StatusCode, Json<AddMagnetResponse>), ApiError> {
    authorize(&state, &headers)?;
    albums::get(&state.db, id)
        .await?
        .ok_or_else(|| not_found("album"))?;
    let magnet = req.magnet.trim().to_string();
    let hash = InfoHash::from_magnet(&magnet)
        .ok_or_else(|| ApiError::bad_request("invalid_magnet", "not a valid magnet link"))?;
    let title = magnet_display_name(&magnet).unwrap_or_else(|| hash.as_str().to_string());
    let torrent = torrents::upsert_by_info_hash(
        &state.db,
        &NewTorrent {
            info_hash: hash,
            magnet,
            source: TorrentSource::Manual,
            source_topic_id: None,
            title,
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Unknown,
        },
    )
    .await?;
    album_torrents::link(&state.db, id, torrent.id, "manual", 1.0).await?;
    let queued = jobs::enqueue(
        &state.db,
        &Job::VerifyTorrent {
            torrent_id: torrent.id,
            album_id: id,
        },
        EnqueueOpts::priority(PRIORITY_INTERACTIVE),
    )
    .await?
    .is_some();
    Ok((
        StatusCode::ACCEPTED,
        Json(AddMagnetResponse {
            torrent: TorrentDto::from(&torrent),
            queued,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::magnet_display_name;

    #[test]
    fn dn_decoding() {
        let m = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=OK+Computer%20%5BFLAC%5D&tr=x";
        assert_eq!(magnet_display_name(m).unwrap(), "OK Computer [FLAC]");
        assert!(magnet_display_name("magnet:?xt=urn:btih:abc").is_none());
        assert_eq!(magnet_display_name("magnet:?dn=100%").unwrap(), "100%");
    }
}
