//! Очередь задач поверх таблицы `jobs`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use nimbus_core::jobs::Job;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgExecutor;

/// Канал `NOTIFY`, по которому раннер просыпается при постановке задачи.
pub const NOTIFY_CHANNEL: &str = "jobs";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub id: i64,
    pub kind: String,
    pub payload: Value,
    pub state: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub priority: i16,
    pub run_after: DateTime<Utc>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub locked_at: Option<DateTime<Utc>>,
    pub locked_by: Option<String>,
    pub last_error: Option<String>,
    pub dedup_key: Option<String>,
    /// Пока задача выполнялась, пришёл новый запрос: по завершении её нужно выполнить ещё раз.
    pub rerun: bool,
    /// Окончательный провал (повтор бессмыслен): оживление такую задачу не трогает.
    pub fatal: bool,
    /// Сколько раз задачу оживляло обслуживание ([`revive_failed`]).
    pub revivals: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRow {
    pub fn job(&self) -> Result<Job, serde_json::Error> {
        Job::from_parts(&self.kind, self.payload.clone())
    }
}

/// Сколько попыток у `process_cue` (около полутора часов с лестницей пауз).
pub const PROCESS_CUE_ATTEMPTS: i32 = 8;

/// Параметры постановки задачи в очередь.
#[derive(Debug, Clone, Copy, Default)]
pub struct EnqueueOpts {
    /// Не раньше какого момента запускать (`None` — сразу).
    pub run_after: Option<DateTime<Utc>>,
    /// Число попыток (`None` — 5).
    pub max_attempts: Option<i32>,
    /// Чем больше, тем раньше задача берётся (см. `nimbus_core::jobs::PRIORITY_*`).
    pub priority: i16,
}

impl EnqueueOpts {
    /// Опции с заданным приоритетом, остальное по умолчанию.
    pub fn priority(priority: i16) -> Self {
        Self {
            priority,
            ..Self::default()
        }
    }

    /// Опции `process_cue`: раздающий может быть офлайн долго, поэтому попыток больше, чем у остальных
    /// (с растущей паузой — см. `nimbus_worker::cue::retry_delay`).
    pub fn process_cue(priority: i16) -> Self {
        Self {
            priority,
            max_attempts: Some(PROCESS_CUE_ATTEMPTS),
            ..Self::default()
        }
    }

    /// Опции с отложенным стартом.
    pub fn at(run_after: DateTime<Utc>) -> Self {
        Self {
            run_after: Some(run_after),
            ..Self::default()
        }
    }
}

/// Ставит задачу в очередь и шлёт `NOTIFY jobs` (одним оператором, атомарно).
/// Возвращает `None`, если задача с таким `dedup_key` уже активна (queued/running); новая строка
/// при этом не создаётся. Запрос не теряется: приоритет ожидающей (`queued`) задачи поднимается
/// до приоритета новой, если тот выше, а у выполняющейся (`running`) выставляется `rerun` —
/// по завершении она будет поставлена в очередь ещё раз (см. [`complete`]).
pub async fn enqueue(
    db: impl PgExecutor<'_>,
    job: &Job,
    opts: EnqueueOpts,
) -> sqlx::Result<Option<i64>> {
    let (kind, payload) = job.to_parts();
    sqlx::query_scalar(
        "WITH ins AS (
            INSERT INTO jobs (kind, payload, dedup_key, run_after, max_attempts, priority)
            VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, 5), $6)
            ON CONFLICT (dedup_key) WHERE state IN ('queued','running') DO NOTHING
            RETURNING id
         ), bump AS (
            UPDATE jobs SET priority = $6, updated_at = now()
            WHERE dedup_key = $3 AND state = 'queued' AND priority < $6
            RETURNING id
         ), rer AS (
            UPDATE jobs SET rerun = TRUE, priority = GREATEST(priority, $6), updated_at = now()
            WHERE dedup_key = $3 AND state = 'running'
            RETURNING id
         )
         SELECT ins.id FROM ins, LATERAL (SELECT pg_notify('jobs', ins.id::text)) n",
    )
    .bind(kind)
    .bind(payload)
    .bind(job.dedup_key())
    .bind(opts.run_after)
    .bind(opts.max_attempts)
    .bind(opts.priority)
    .fetch_optional(db)
    .await
}

/// Забирает следующую готовую задачу одного из видов `kinds` (`FOR UPDATE SKIP LOCKED`):
/// сначала по приоритету, затем по `run_after`.
pub async fn claim(
    db: impl PgExecutor<'_>,
    worker_id: &str,
    kinds: &[&str],
) -> sqlx::Result<Option<JobRow>> {
    sqlx::query_as(
        "UPDATE jobs SET state = 'running', locked_at = now(), heartbeat_at = now(), locked_by = $1,
                         attempts = attempts + 1, updated_at = now()
         WHERE id = (
            SELECT id FROM jobs
            WHERE state = 'queued' AND run_after <= now() AND kind = ANY($2)
            ORDER BY priority DESC, run_after, id
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING *",
    )
    .bind(worker_id)
    .bind(kinds)
    .fetch_optional(db)
    .await
}

/// Отмечает, что воркер `worker_id` всё ещё выполняет задачу `id`.
/// Возвращает `false`, если задача уже не принадлежит этому воркеру (завершена, отобрана).
pub async fn heartbeat(db: impl PgExecutor<'_>, id: i64, worker_id: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "UPDATE jobs SET heartbeat_at = now() WHERE id = $1 AND state = 'running' AND locked_by = $2",
    )
    .bind(id)
    .bind(worker_id)
    .execute(db)
    .await?
    .rows_affected()
        > 0)
}

/// Итог [`complete`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    /// Задача завершена (`done`).
    Done,
    /// Пока задача выполнялась, пришёл новый запрос (`rerun`): она снова `queued` со свежим циклом попыток.
    Requeued,
    /// Задачу у этого воркера перехватили: строка не тронута, итог запишет новый владелец.
    Lost,
}

/// Завершает задачу успешно. `worker_id` — воркер, взявший её через [`claim`]: если задачу уже
/// перехватили (`requeue_stale` вернул её в очередь и взял другой воркер), строка не меняется
/// ([`Completion::Lost`]). Если во время выполнения пришёл повторный запрос (`rerun`), задача
/// ставится в очередь заново с нулём попыток ([`Completion::Requeued`]).
pub async fn complete(
    db: impl PgExecutor<'_>,
    id: i64,
    worker_id: &str,
) -> sqlx::Result<Completion> {
    let state: Option<String> = sqlx::query_scalar(
        "WITH upd AS (
            UPDATE jobs SET
                state = CASE WHEN rerun THEN 'queued' ELSE 'done' END,
                attempts = CASE WHEN rerun THEN 0 ELSE attempts END,
                run_after = CASE WHEN rerun THEN now() ELSE run_after END,
                rerun = FALSE,
                locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
            WHERE id = $1 AND state = 'running' AND locked_by = $2
            RETURNING id, state
         )
         SELECT upd.state FROM upd
         LEFT JOIN LATERAL (SELECT pg_notify('jobs', upd.id::text) WHERE upd.state = 'queued') n ON TRUE",
    )
    .bind(id)
    .bind(worker_id)
    .fetch_optional(db)
    .await?;
    Ok(match state.as_deref() {
        None => Completion::Lost,
        Some("queued") => Completion::Requeued,
        Some(_) => Completion::Done,
    })
}

/// Если задан `retry_at` и попытки не исчерпаны — задача возвращается в `queued`
/// с `run_after = retry_at`, иначе становится `failed`. Исключение — окончательный провал при
/// выставленном `rerun`: новый запрос заслуживает своего цикла попыток, задача снова `queued`
/// с нулём попыток (вызывающий смотрит на `state` и `on_exhausted` не вызывает).
/// `fatal` записывается только при переходе в `failed`: окончательный провал, который не оживляют.
/// `None` — задачу у `worker_id` перехватили, строка не тронута.
pub async fn fail(
    db: impl PgExecutor<'_>,
    id: i64,
    worker_id: &str,
    error: &str,
    retry_at: Option<DateTime<Utc>>,
    fatal: bool,
) -> sqlx::Result<Option<JobRow>> {
    sqlx::query_as(
        "WITH upd AS (
            UPDATE jobs SET
                last_error = $2,
                state = CASE WHEN ($3::timestamptz IS NOT NULL AND attempts < max_attempts) OR rerun THEN 'queued' ELSE 'failed' END,
                run_after = CASE WHEN $3::timestamptz IS NOT NULL AND attempts < max_attempts THEN $3
                                 WHEN rerun THEN now() ELSE run_after END,
                attempts = CASE WHEN rerun AND NOT ($3::timestamptz IS NOT NULL AND attempts < max_attempts) THEN 0 ELSE attempts END,
                fatal = $5 AND NOT (($3::timestamptz IS NOT NULL AND attempts < max_attempts) OR rerun),
                rerun = FALSE,
                locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
            WHERE id = $1 AND state = 'running' AND locked_by = $4
            RETURNING *
         )
         SELECT upd.* FROM upd
         LEFT JOIN LATERAL (SELECT pg_notify('jobs', upd.id::text) WHERE upd.state = 'queued') n ON TRUE",
    )
    .bind(id)
    .bind(error)
    .bind(retry_at)
    .bind(worker_id)
    .bind(fatal)
    .fetch_optional(db)
    .await
}

/// Откладывает задачу «без вины»: возвращает в `queued` с `run_after = retry_at`, **не тратя попытку**
/// (причина не в задаче: провайдер недоступен, предохранитель разомкнут). Чтобы отложенная задача не жила
/// вечно, после `max_age` с момента создания она становится `failed` (тогда вызывается `on_exhausted`);
/// при выставленном `rerun` — вместо этого `queued` с нулём попыток, как в [`fail`].
/// `None` — задачу у `worker_id` перехватили, строка не тронута.
pub async fn defer(
    db: impl PgExecutor<'_>,
    id: i64,
    worker_id: &str,
    reason: &str,
    retry_at: DateTime<Utc>,
    max_age: Duration,
) -> sqlx::Result<Option<JobRow>> {
    sqlx::query_as(
        "WITH upd AS (
            UPDATE jobs SET
                last_error = $2,
                state = CASE WHEN created_at < now() - make_interval(secs => $4) AND NOT rerun THEN 'failed' ELSE 'queued' END,
                attempts = CASE WHEN rerun AND created_at < now() - make_interval(secs => $4) THEN 0 ELSE GREATEST(attempts - 1, 0) END,
                run_after = CASE WHEN rerun AND created_at < now() - make_interval(secs => $4) THEN now() ELSE $3 END,
                rerun = FALSE,
                locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
            WHERE id = $1 AND state = 'running' AND locked_by = $5
            RETURNING *
         )
         SELECT upd.* FROM upd
         LEFT JOIN LATERAL (SELECT pg_notify('jobs', upd.id::text) WHERE upd.state = 'queued' AND upd.run_after <= now()) n ON TRUE",
    )
    .bind(id)
    .bind(reason)
    .bind(retry_at)
    .bind(max_age.as_secs_f64())
    .bind(worker_id)
    .fetch_optional(db)
    .await
}

/// Итог [`requeue_stale`].
#[derive(Debug, Default)]
pub struct StaleOutcome {
    /// Сколько задач вернулось в `queued`.
    pub requeued: u64,
    /// Задачи, у которых кончились попытки: стали `failed` (для них нужно вызвать `on_exhausted`).
    pub failed: Vec<JobRow>,
}

/// Аварийный путь: возвращает в очередь задачи, у которых `heartbeat_at` (а при его отсутствии —
/// `locked_at`) старше `older_than` — воркер умер. Попытка **не** возвращается: «ядовитая» задача,
/// роняющая процесс, исчерпает попытки и станет `failed`, а не будет перезапускаться бесконечно.
pub async fn requeue_stale(
    db: impl PgExecutor<'_>,
    older_than: Duration,
) -> sqlx::Result<StaleOutcome> {
    let rows: Vec<JobRow> = sqlx::query_as(
        "UPDATE jobs SET
            state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = CASE WHEN attempts >= max_attempts THEN 'worker lost; attempts exhausted' ELSE last_error END,
            rerun = FALSE, locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
         WHERE state = 'running'
           AND COALESCE(heartbeat_at, locked_at) < now() - make_interval(secs => $1)
         RETURNING *",
    )
    .bind(older_than.as_secs_f64())
    .fetch_all(db)
    .await?;
    let mut out = StaleOutcome::default();
    for r in rows {
        if r.state == "failed" {
            out.failed.push(r);
        } else {
            out.requeued += 1;
        }
    }
    Ok(out)
}

/// Штатный путь: возвращает в `queued` **все** задачи `running` и возвращает потраченную попытку.
/// Вызывается при старте до запуска воркеров: допущение — в процессе работает один экземпляр
/// воркеров на БД, поэтому всё `running` на этот момент осиротело.
pub async fn recover_orphans(db: impl PgExecutor<'_>) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), run_after = now(), rerun = FALSE,
                         locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
         WHERE state = 'running'",
    )
    .execute(db)
    .await?
    .rows_affected())
}

/// То же, что [`recover_orphans`], но только для задач, захваченных указанными воркерами
/// (остановка процесса: задачи, не успевшие завершиться за `shutdown_timeout`).
pub async fn release_workers(db: impl PgExecutor<'_>, worker_ids: &[String]) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), run_after = now(), rerun = FALSE,
                         locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
         WHERE state = 'running' AND locked_by = ANY($1)",
    )
    .bind(worker_ids)
    .execute(db)
    .await?
    .rows_affected())
}

/// Возвращает одну задачу в `queued` без траты попытки (обработчик прерван отменой).
/// `false` — задача уже не принадлежит `worker_id`, строка не тронута.
pub async fn release(db: impl PgExecutor<'_>, id: i64, worker_id: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "UPDATE jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), run_after = now(), rerun = FALSE,
                         locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
         WHERE id = $1 AND state = 'running' AND locked_by = $2",
    )
    .bind(id)
    .bind(worker_id)
    .execute(db)
    .await?
    .rows_affected()
        > 0)
}

/// Удаляет завершённые (`done`) задачи старше `older_than`.
pub async fn purge_done(db: impl PgExecutor<'_>, older_than: Duration) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM jobs WHERE state = 'done' AND updated_at < now() - make_interval(secs => $1)",
    )
    .bind(older_than.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected())
}

/// Удаляет `failed`-задачи старше `older_than`, которые больше не нужны: окончательные (`fatal`)
/// и вытесненные более новой строкой с тем же `dedup_key`. Последние нефатальные остаются —
/// их видно в «Фоновых задачах», а оживление ещё может их поднять.
pub async fn purge_failed(db: impl PgExecutor<'_>, older_than: Duration) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM jobs j
         WHERE j.state = 'failed' AND j.updated_at < now() - make_interval(secs => $1)
           AND (j.fatal OR EXISTS (SELECT 1 FROM jobs n WHERE n.dedup_key = j.dedup_key AND n.id > j.id))",
    )
    .bind(older_than.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected())
}

/// Оживляет упавшие (`failed`, не `fatal`) задачи видов `kinds`: возвращает их в очередь с нулём попыток.
/// Пауза перед оживлением зависит от числа прошлых оживлений: `delays[revivals]`, последнее значение
/// повторяется. Берётся только последняя задача с данным `dedup_key` и только если нет активной такой же.
/// Возвращает оживлённые строки (для хука `on_retry`).
pub async fn revive_failed(
    db: impl PgExecutor<'_>,
    kinds: &[&str],
    delays: &[Duration],
) -> sqlx::Result<Vec<JobRow>> {
    if delays.is_empty() || kinds.is_empty() {
        return Ok(Vec::new());
    }
    let secs: Vec<f64> = delays.iter().map(Duration::as_secs_f64).collect();
    sqlx::query_as(
        "WITH upd AS (
            UPDATE jobs j SET state = 'queued', attempts = 0, run_after = now(), revivals = revivals + 1,
                              priority = LEAST(priority, 0), rerun = FALSE, updated_at = now()
            WHERE j.state = 'failed' AND NOT j.fatal AND j.kind = ANY($1)
              AND j.updated_at < now() - make_interval(secs => ($2::float8[])[LEAST(j.revivals + 1, cardinality($2::float8[]))])
              AND j.id = (SELECT max(x.id) FROM jobs x WHERE x.dedup_key = j.dedup_key)
              AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.dedup_key = j.dedup_key AND a.state IN ('queued','running'))
            RETURNING j.*
         )
         SELECT upd.* FROM upd LEFT JOIN LATERAL (SELECT pg_notify('jobs', upd.id::text)) n ON TRUE",
    )
    .bind(kinds)
    .bind(secs)
    .fetch_all(db)
    .await
}

pub async fn list(
    db: impl PgExecutor<'_>,
    state: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<JobRow>> {
    list_filtered(db, state, None, limit).await
}

/// Список задач (новые первыми) с фильтрами по состоянию и виду.
pub async fn list_filtered(
    db: impl PgExecutor<'_>,
    state: Option<&str>,
    kind: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<JobRow>> {
    sqlx::query_as(
        "SELECT * FROM jobs
         WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR kind = $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(state)
    .bind(kind)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Число задач по состояниям (без `done`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JobCounts {
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
}

pub async fn counts(db: impl PgExecutor<'_>) -> sqlx::Result<JobCounts> {
    let (queued, running, failed): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE state = 'queued'),
                count(*) FILTER (WHERE state = 'running'),
                count(*) FILTER (WHERE state = 'failed')
         FROM jobs",
    )
    .fetch_one(db)
    .await?;
    Ok(JobCounts {
        queued,
        running,
        failed,
    })
}

/// Результат [`retry`].
#[derive(Debug)]
pub enum RetryOutcome {
    /// Задача снова в очереди.
    Queued(Box<JobRow>),
    NotFound,
    /// Задача не в состоянии `failed`.
    NotFailed,
    /// Уже есть активная задача с тем же `dedup_key`.
    Duplicate,
}

/// Повторный запуск `failed`-задачи: попытки обнуляются, приоритет — интерактивный.
pub async fn retry(db: &sqlx::PgPool, id: i64, priority: i16) -> sqlx::Result<RetryOutcome> {
    let res: sqlx::Result<Option<JobRow>> = sqlx::query_as(
        "UPDATE jobs SET state = 'queued', attempts = 0, run_after = now(), priority = $2,
                         fatal = FALSE, revivals = 0,
                         locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, updated_at = now()
         WHERE id = $1 AND state = 'failed' RETURNING *",
    )
    .bind(id)
    .bind(priority)
    .fetch_optional(db)
    .await;
    match res {
        Ok(Some(row)) => {
            sqlx::query("SELECT pg_notify('jobs', $1)")
                .bind(id.to_string())
                .execute(db)
                .await?;
            Ok(RetryOutcome::Queued(Box::new(row)))
        }
        Ok(None) => {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM jobs WHERE id = $1)")
                    .bind(id)
                    .fetch_one(db)
                    .await?;
            Ok(if exists {
                RetryOutcome::NotFailed
            } else {
                RetryOutcome::NotFound
            })
        }
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Ok(RetryOutcome::Duplicate),
        Err(e) => Err(e),
    }
}

/// Понижает ожидающие `verify_torrent` альбома до фонового приоритета
/// (резервные источники не должны мешать более важной работе).
pub async fn demote_queued_verifies(
    db: impl PgExecutor<'_>,
    album_id: i64,
    priority: i16,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE jobs SET priority = LEAST(priority, $2), updated_at = now()
         WHERE kind = 'verify_torrent' AND state = 'queued' AND payload->>'album_id' = $1::text",
    )
    .bind(album_id)
    .bind(priority)
    .execute(db)
    .await?
    .rows_affected())
}

/// Есть ли у альбома ожидающая (`queued`) или выполняющаяся (`running`) задача поиска:
/// `discover_album` самого альбома или `discover_artist` его артиста (дискографии привязываются
/// к альбому только после её завершения). `ignore_key` — `dedup_key` задачи, которая спрашивает
/// о себе (её собственная запись ещё `running`).
pub async fn has_queued_discover(
    db: impl PgExecutor<'_>,
    album_id: i64,
    ignore_key: Option<&str>,
) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1 FROM jobs
            WHERE state IN ('queued','running')
              AND dedup_key IN (
                  'discover_album:' || $1::text,
                  'discover_artist:' || (SELECT artist_id::text FROM albums WHERE id = $1))
              AND dedup_key IS DISTINCT FROM $2)",
    )
    .bind(album_id)
    .bind(ignore_key)
    .fetch_one(db)
    .await
}

/// Сколько записей журнала хранится в прогрессе импорта (старые отбрасываются).
pub const IMPORT_LOG_LIMIT: usize = 300;

/// Фаза импорта дискографии.
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportPhase {
    /// Запрашиваем список release group'ов у MusicBrainz.
    Groups,
    /// Добавляем альбомы по одному.
    Albums,
    /// Альбомы добавлены, ставим поиск источников.
    Discover,
}

/// Запись журнала импорта (текст английский, для раскрывающегося списка «Подробности»).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ImportLogEntry {
    pub at: DateTime<Utc>,
    pub text: String,
}

/// Прогресс `import_artist`; хранится в `jobs.progress`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ImportProgress {
    pub phase: ImportPhase,
    /// Обработано release group'ов (добавлено + пропущено).
    pub done: u32,
    pub total: u32,
    /// Альбом, который обрабатывается сейчас.
    pub current: Option<String>,
    pub imported: u32,
    pub skipped: u32,
    pub log: Vec<ImportLogEntry>,
}

impl ImportProgress {
    pub fn new() -> Self {
        Self {
            phase: ImportPhase::Groups,
            done: 0,
            total: 0,
            current: None,
            imported: 0,
            skipped: 0,
            log: Vec::new(),
        }
    }

    pub fn log(&mut self, text: impl Into<String>) {
        self.log.push(ImportLogEntry {
            at: Utc::now(),
            text: text.into(),
        });
        if self.log.len() > IMPORT_LOG_LIMIT {
            let excess = self.log.len() - IMPORT_LOG_LIMIT;
            self.log.drain(..excess);
        }
    }
}

impl Default for ImportProgress {
    fn default() -> Self {
        Self::new()
    }
}

/// Сохраняет прогресс активной задачи `import_artist` артиста.
pub async fn set_import_progress(
    db: impl PgExecutor<'_>,
    artist_id: i64,
    progress: &ImportProgress,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE jobs SET progress = $2
         WHERE kind = 'import_artist' AND payload->>'artist_id' = $1::text
           AND state IN ('queued','running')",
    )
    .bind(artist_id)
    .bind(serde_json::to_value(progress).unwrap_or(Value::Null))
    .execute(db)
    .await?;
    Ok(())
}
