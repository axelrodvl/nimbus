//! Приобретение альбомов: вычисляемое состояние, список проблемных и ещё не скачанных,
//! сводка и массовый повтор поиска (серверная половина экрана «Загрузки»).

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use chrono::{DateTime, Utc};
use nimbus_core::jobs::PRIORITY_INTERACTIVE;
use nimbus_core::model::{AcquisitionState, SearchOutcome};
use nimbus_db::repo::acquisition::{self, AcquisitionRow, Cursor, MAX_BULK_RETRY, MAX_PAGE};
use nimbus_db::repo::jobs;
use nimbus_library::retry::{retry_album, RetryOptions};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::auth::authorize;
use crate::error::{ApiError, ErrorResponse};
use crate::extract::ApiJson;
use crate::state::AppState;

const DEFAULT_PAGE: i64 = 50;

#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionArtist {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionAlbum {
    pub id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub artist: AcquisitionArtist,
}

/// Треки альбома из библиотеки по статусам.
#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionTracks {
    pub total: u32,
    pub adding: u32,
    pub found: u32,
    pub not_found: u32,
    pub ready: u32,
}

/// Отказ провайдера при последнем поиске.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ProviderErrorDto {
    pub source: String,
    pub error: String,
}

/// Что известно о поиске раздач альбома.
#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionSearch {
    /// Сколько поисков завершено.
    pub attempts: u32,
    pub last_finished_at: Option<DateTime<Utc>>,
    pub last_outcome: Option<SearchOutcome>,
    /// Сколько раздач дал последний поиск.
    pub candidates: u32,
    pub provider_errors: Vec<ProviderErrorDto>,
    /// Когда сработает авто-повтор (`null` — не запланирован).
    pub next_retry_at: Option<DateTime<Utc>>,
}

/// Прогресс активной загрузки файлов альбома.
#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionDownload {
    pub bytes_done: i64,
    pub bytes_total: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionItem {
    pub album: AcquisitionAlbum,
    pub state: AcquisitionState,
    pub tracks: AcquisitionTracks,
    /// Преобладающая причина `not_found`-треков: `search_failed` > `no_torrents` > `dead_torrents` > `no_match`.
    pub reason: Option<String>,
    pub search: AcquisitionSearch,
    pub download: Option<AcquisitionDownload>,
    /// Задачи поиска/проверки/CUE по альбому в очереди или в работе.
    pub active_jobs: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionPage {
    pub items: Vec<AcquisitionItem>,
    pub next_cursor: Option<String>,
}

/// Сколько альбомов в каждом состоянии и сколько задач очереди провалено.
#[derive(Debug, Serialize, ToSchema)]
pub struct AcquisitionSummary {
    pub searching: i64,
    pub missing: i64,
    pub partial: i64,
    pub available: i64,
    pub downloading: i64,
    pub downloaded: i64,
    pub failed_jobs: i64,
}

fn count(v: i32) -> u32 {
    u32::try_from(v).unwrap_or(0)
}

impl From<AcquisitionRow> for AcquisitionItem {
    fn from(r: AcquisitionRow) -> Self {
        let download = match (r.bytes_done, r.bytes_total) {
            (Some(bytes_done), Some(bytes_total)) => Some(AcquisitionDownload {
                bytes_done,
                bytes_total,
            }),
            _ => None,
        };
        Self {
            album: AcquisitionAlbum {
                id: r.album_id,
                title: r.title,
                year: r.year,
                cover_url: r.cover_url,
                artist: AcquisitionArtist {
                    id: r.artist_id,
                    name: r.artist_name,
                },
            },
            state: r.state,
            tracks: AcquisitionTracks {
                total: count(r.total),
                adding: count(r.adding),
                found: count(r.found),
                not_found: count(r.not_found),
                ready: count(r.ready),
            },
            reason: r.reason,
            search: AcquisitionSearch {
                attempts: count(r.attempts),
                last_finished_at: r.last_finished_at,
                last_outcome: r.last_outcome,
                candidates: count(r.candidates),
                provider_errors: serde_json::from_value(r.provider_errors).unwrap_or_default(),
                next_retry_at: r.next_retry_at,
            },
            download,
            active_jobs: u32::try_from(r.active_jobs).unwrap_or(u32::MAX),
        }
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AcquisitionParams {
    /// Фильтр по состояниям через запятую: searching, missing, partial, available, downloading, downloaded.
    state: Option<String>,
    /// Курсор из `next_cursor` предыдущей страницы.
    cursor: Option<String>,
    /// 1..200, по умолчанию 50.
    limit: Option<i64>,
}

fn parse_states(raw: Option<&str>) -> Result<Option<Vec<AcquisitionState>>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    raw.split(',')
        .map(|s| {
            s.trim().parse::<AcquisitionState>().map_err(|_| {
                ApiError::bad_request(
                    "invalid_state",
                    "state must be a comma-separated list of searching, missing, partial, available, downloading, downloaded",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[utoipa::path(
    get,
    path = "/api/acquisition",
    tag = "acquisition",
    params(AcquisitionParams),
    responses(
        (status = 200, description = "Альбомы библиотеки с состоянием приобретения: сначала ищущиеся, затем по времени последнего поиска", body = AcquisitionPage),
        (status = 400, description = "Неверный `state` (`invalid_state`) или курсор (`invalid_cursor`)", body = ErrorResponse),
    )
)]
pub async fn list_acquisition(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<AcquisitionParams>,
) -> Result<Json<AcquisitionPage>, ApiError> {
    authorize(&state, &headers)?;
    let states = parse_states(p.state.as_deref())?;
    let cursor = match p.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => Some(
            Cursor::decode(c)
                .ok_or_else(|| ApiError::bad_request("invalid_cursor", "malformed cursor"))?,
        ),
        None => None,
    };
    let limit = p.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let page = acquisition::list(&state.db, states.as_deref(), cursor.as_ref(), limit).await?;
    Ok(Json(AcquisitionPage {
        next_cursor: page.next.as_ref().map(Cursor::encode),
        items: page.items.into_iter().map(AcquisitionItem::from).collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/api/acquisition/summary",
    tag = "acquisition",
    responses((status = 200, description = "Число альбомов по состояниям и проваленных задач", body = AcquisitionSummary))
)]
pub async fn acquisition_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AcquisitionSummary>, ApiError> {
    authorize(&state, &headers)?;
    let s = acquisition::summary(&state.db).await?;
    let failed_jobs = jobs::counts(&state.db).await?.failed;
    Ok(Json(AcquisitionSummary {
        searching: s.searching,
        missing: s.missing,
        partial: s.partial,
        available: s.available,
        downloading: s.downloading,
        downloaded: s.downloaded,
        failed_jobs,
    }))
}

/// Какие альбомы повторять.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetryScope {
    /// Все альбомы в состояниях `missing` и `partial` (не больше 5000 за вызов).
    Missing,
    /// Альбомы из `album_ids`.
    Albums,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RetryAcquisitionRequest {
    pub scope: RetryScope,
    /// Нужен при `scope = "albums"` (не больше 5000).
    pub album_ids: Option<Vec<i64>>,
    /// Раздачи с `dead|timeout|error` вернуть в `pending`: их проверят заново.
    #[serde(default)]
    pub reset_dead: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RetryAcquisitionResponse {
    /// Сколько существующих альбомов поставлено на повтор.
    pub queued: u32,
}

#[utoipa::path(
    post,
    path = "/api/acquisition/retry",
    tag = "acquisition",
    request_body = RetryAcquisitionRequest,
    responses(
        (status = 202, description = "Поиск поставлен в очередь с интерактивным приоритетом; счёт авто-повторов начат заново", body = RetryAcquisitionResponse),
        (status = 400, description = "Нет `album_ids` при `scope = albums` или их больше 5000", body = ErrorResponse),
    )
)]
pub async fn retry_acquisition(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<RetryAcquisitionRequest>,
) -> Result<(axum::http::StatusCode, Json<RetryAcquisitionResponse>), ApiError> {
    authorize(&state, &headers)?;
    let ids = match req.scope {
        RetryScope::Missing => {
            acquisition::ids_in_states(
                &state.db,
                &[AcquisitionState::Missing, AcquisitionState::Partial],
                MAX_BULK_RETRY,
            )
            .await?
        }
        RetryScope::Albums => {
            let mut ids = req.album_ids.ok_or_else(|| {
                ApiError::bad_request(
                    "bad_request",
                    "`album_ids` is required for scope \"albums\"",
                )
            })?;
            if ids.len() as i64 > MAX_BULK_RETRY {
                return Err(ApiError::bad_request(
                    "too_many_albums",
                    format!("at most {MAX_BULK_RETRY} albums per call"),
                ));
            }
            ids.sort_unstable();
            ids.dedup();
            acquisition::existing_albums(&state.db, &ids).await?
        }
    };
    let opts = RetryOptions {
        priority: PRIORITY_INTERACTIVE,
        reset_dead: req.reset_dead,
        manual: true,
    };
    for id in &ids {
        retry_album(&state.db, &state.events, *id, opts).await?;
    }
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(RetryAcquisitionResponse {
            queued: u32::try_from(ids.len()).unwrap_or(u32::MAX),
        }),
    ))
}
