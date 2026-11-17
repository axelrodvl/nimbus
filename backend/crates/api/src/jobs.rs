//! Очередь задач: просмотр и ручной повтор неудавшихся (`/api/jobs`).

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use nimbus_core::jobs::PRIORITY_INTERACTIVE;
use nimbus_db::repo::invariants;
use nimbus_db::repo::jobs::{self, JobRow, RetryOutcome};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::auth::authorize;
use crate::error::{ApiError, ErrorResponse};
use crate::state::AppState;

/// Задача очереди.
#[derive(Debug, Serialize, ToSchema)]
pub struct JobDto {
    pub id: i64,
    /// Вид: `discover_album`, `verify_torrent`, `import_artist`, …
    pub kind: String,
    pub payload: Value,
    /// `queued` | `running` | `done` | `failed`.
    pub state: String,
    pub attempts: i32,
    pub max_attempts: i32,
    /// Чем больше, тем раньше берётся (интерактивные — 10, обычные — 0, фоновые — -10).
    pub priority: i16,
    pub run_after: DateTime<Utc>,
    pub last_error: Option<String>,
    /// Окончательный провал: автоматически задача не оживёт (только ручной повтор).
    pub fatal: bool,
    pub updated_at: DateTime<Utc>,
}

impl From<JobRow> for JobDto {
    fn from(r: JobRow) -> Self {
        Self {
            id: r.id,
            kind: r.kind,
            payload: r.payload,
            state: r.state,
            attempts: r.attempts,
            max_attempts: r.max_attempts,
            priority: r.priority,
            run_after: r.run_after,
            last_error: r.last_error,
            fatal: r.fatal,
            updated_at: r.updated_at,
        }
    }
}

/// Сколько задач в каждом активном состоянии (`done` не считаются).
#[derive(Debug, Serialize, ToSchema)]
pub struct JobCountsDto {
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct JobsResponse {
    pub jobs: Vec<JobDto>,
    pub counts: JobCountsDto,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct JobsQuery {
    /// Фильтр по состоянию: `queued`, `running`, `done`, `failed`.
    state: Option<String>,
    /// Фильтр по виду задачи.
    kind: Option<String>,
    /// Сколько вернуть (1–500, по умолчанию 50).
    limit: Option<i64>,
}

const STATES: [&str; 4] = ["queued", "running", "done", "failed"];

#[utoipa::path(
    get,
    path = "/api/jobs",
    tag = "jobs",
    params(JobsQuery),
    responses(
        (status = 200, description = "Задачи (новые первыми) и счётчики по состояниям", body = JobsResponse),
        (status = 400, description = "Неизвестное состояние (`invalid_state`)", body = ErrorResponse),
    )
)]
pub async fn list_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<JobsQuery>,
) -> Result<Json<JobsResponse>, ApiError> {
    authorize(&state, &headers)?;
    let st = q.state.as_deref().filter(|s| !s.is_empty());
    if let Some(s) = st {
        if !STATES.contains(&s) {
            return Err(ApiError::bad_request(
                "invalid_state",
                format!("state must be one of {STATES:?}"),
            ));
        }
    }
    let kind = q.kind.as_deref().filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = jobs::list_filtered(&state.db, st, kind, limit).await?;
    let c = jobs::counts(&state.db).await?;
    Ok(Json(JobsResponse {
        jobs: rows.into_iter().map(JobDto::from).collect(),
        counts: JobCountsDto {
            queued: c.queued,
            running: c.running,
            failed: c.failed,
        },
    }))
}

#[utoipa::path(
    post,
    path = "/api/jobs/{id}/retry",
    tag = "jobs",
    params(("id" = i64, Path, description = "Id задачи")),
    responses(
        (status = 200, description = "Задача снова в очереди (попытки обнулены, приоритет интерактивный)", body = JobDto),
        (status = 404, description = "Нет такой задачи", body = ErrorResponse),
        (status = 409, description = "Задача не `failed` (`not_failed`) или уже есть активная такая же (`duplicate`)", body = ErrorResponse),
    )
)]
pub async fn retry_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<JobDto>, ApiError> {
    authorize(&state, &headers)?;
    match jobs::retry(&state.db, id, PRIORITY_INTERACTIVE).await? {
        RetryOutcome::Queued(row) => Ok(Json((*row).into())),
        RetryOutcome::NotFound => Err(ApiError::not_found("job not found")),
        RetryOutcome::NotFailed => Err(ApiError::new(
            StatusCode::CONFLICT,
            "not_failed",
            "only failed jobs can be retried",
        )),
        RetryOutcome::Duplicate => Err(ApiError::new(
            StatusCode::CONFLICT,
            "duplicate",
            "an identical job is already active",
        )),
    }
}

/// Одно застрявшее состояние.
#[derive(Debug, Serialize, ToSchema)]
pub struct ViolationDto {
    /// Код инварианта: `I1` … `I12` (расшифровка — `docs/operations.md`, «Застрявшие состояния»).
    pub invariant: String,
    /// Вид сущности: `album`, `album_torrent`, `cue_candidate`, `job`, `pin`, `track`, `artist`.
    pub entity: String,
    pub id: i64,
    pub detail: String,
}

/// Нарушения одного инварианта.
#[derive(Debug, Serialize, ToSchema)]
pub struct InvariantSectionDto {
    pub invariant: String,
    /// Сколько нарушителей всего (в `violations` — не больше 50).
    pub count: i64,
    pub violations: Vec<ViolationDto>,
}

/// Отчёт проверки «ничего не застряло».
#[derive(Debug, Serialize, ToSchema)]
pub struct InvariantsResponse {
    pub checked_at: DateTime<Utc>,
    /// Сколько секунд состояние может длиться без исполнителя, прежде чем считается застрявшим.
    pub grace_secs: u64,
    /// Общее число нарушений.
    pub total: i64,
    /// Только нарушенные инварианты.
    pub sections: Vec<InvariantSectionDto>,
}

impl From<invariants::Report> for InvariantsResponse {
    fn from(r: invariants::Report) -> Self {
        Self {
            checked_at: r.checked_at,
            grace_secs: r.grace_secs,
            total: r.total,
            sections: r
                .sections
                .into_iter()
                .map(|s| InvariantSectionDto {
                    invariant: s.invariant.to_string(),
                    count: s.count,
                    violations: s
                        .violations
                        .into_iter()
                        .map(|v| ViolationDto {
                            invariant: v.invariant.to_string(),
                            entity: v.entity.to_string(),
                            id: v.id,
                            detail: v.detail,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// Отсрочка по умолчанию: столько же, сколько у периодической проверки обслуживания.
const DEFAULT_GRACE_SECS: u64 = 30 * 60;
const MAX_GRACE_SECS: u64 = 24 * 3600;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct InvariantsQuery {
    /// Отсрочка в секундах (0–86400, по умолчанию 1800): состояния моложе не считаются застрявшими.
    grace_secs: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/api/jobs/invariants",
    tag = "jobs",
    params(InvariantsQuery),
    responses(
        (status = 200, description = "Застрявшие состояния: сущности, которые ждут фоновой работы, а выполнить её некому. Пустой отчёт — норма", body = InvariantsResponse),
        (status = 400, description = "Отсрочка вне диапазона (`invalid_grace`)", body = ErrorResponse),
    )
)]
pub async fn job_invariants(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<InvariantsQuery>,
) -> Result<Json<InvariantsResponse>, ApiError> {
    authorize(&state, &headers)?;
    let grace = q.grace_secs.unwrap_or(DEFAULT_GRACE_SECS);
    if grace > MAX_GRACE_SECS {
        return Err(ApiError::bad_request(
            "invalid_grace",
            format!("grace_secs must be between 0 and {MAX_GRACE_SECS}"),
        ));
    }
    let mut params = invariants::Params::new(std::time::Duration::from_secs(grace));
    params.auto_retry = state.settings.get().search.auto_retry;
    let report = invariants::check_all(&state.db, &params).await?;
    // Проверка с обычной отсрочкой заодно обновляет счётчик `GET /api/health` → `stuck`.
    if grace == DEFAULT_GRACE_SECS {
        state
            .worker_stats
            .set_stuck(u64::try_from(report.total).unwrap_or_default());
    }
    Ok(Json(report.into()))
}
