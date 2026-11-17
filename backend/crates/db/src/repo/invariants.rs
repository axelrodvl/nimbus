//! Инварианты «ничего не застряло» (ревью B14): по запросу на каждое состояние «в процессе».
//!
//! Каждый запрос возвращает нарушителей — сущности, которые ждут фоновой работы, а выполнить её
//! некому. Модуль только читает: чинят страховки обслуживания (`finalize_stuck_albums`,
//! `adopt_orphans`, `revive_failed`, `requeue_stale`, менеджер загрузок). Непустой отчёт дольше
//! `grace` означает, что страховка не справилась, — это дефект, а не штатная ситуация.
//!
//! Новая фоновая сущность с состоянием «в процессе» обязана получить инвариант здесь
//! (`docs/DEVELOPMENT.md` §3).

use std::time::Duration;

use chrono::{DateTime, Utc};
use nimbus_core::jobs::Job;
use serde::Serialize;
use sqlx::PgPool;

/// Сколько нарушений одного инварианта попадает в отчёт (счётчик при этом полный).
pub const MAX_VIOLATIONS: i64 = 50;

/// Одно нарушение: какая сущность застряла и почему.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Violation {
    /// Код инварианта: `I1` … `I12`.
    pub invariant: &'static str,
    /// Вид сущности: `album`, `album_torrent`, `cue_candidate`, `job`, `pin`, `download`, `artist`.
    pub entity: &'static str,
    /// Идентификатор сущности (для связей — `album_id` / `track_id` / `torrent_id`, уточнение в `detail`).
    pub id: i64,
    pub detail: String,
}

/// Нарушения одного инварианта.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    pub invariant: &'static str,
    /// Сколько нарушителей всего (в `violations` — не больше [`MAX_VIOLATIONS`]).
    pub count: i64,
    pub violations: Vec<Violation>,
}

/// Итог [`check_all`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub checked_at: DateTime<Utc>,
    pub grace_secs: u64,
    /// Общее число нарушений по всем инвариантам.
    pub total: i64,
    /// Только нарушенные инварианты, по порядку кодов.
    pub sections: Vec<Section>,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        self.total == 0
    }

    /// Нарушения инварианта `code` (пусто, если он выполнен).
    pub fn of(&self, code: &str) -> &[Violation] {
        self.sections
            .iter()
            .find(|s| s.invariant == code)
            .map(|s| s.violations.as_slice())
            .unwrap_or_default()
    }
}

/// Параметры проверки.
#[derive(Debug, Clone)]
pub struct Params {
    /// Сколько состояние может длиться законно (страховки не мгновенны).
    pub grace: Duration,
    /// Без heartbeat дольше этого задача `running` считается зависшей (`WorkerConfig::stale_after`).
    pub stale_after: Duration,
    /// Самая длинная пауза перед оживлением упавшей задачи (`WorkerConfig::revive_delays`).
    pub revive_max: Duration,
    /// Виды задач, для которых запущены обработчики.
    pub known_kinds: Vec<String>,
    /// Включён ли авто-повтор поиска (`search.auto_retry`): без него I4 не проверяется.
    pub auto_retry: bool,
}

impl Params {
    /// Значения боевого процесса: все виды задач, `stale_after` 90 с, оживление не реже раза в сутки.
    pub fn new(grace: Duration) -> Self {
        Self {
            grace,
            stale_after: Duration::from_secs(90),
            revive_max: Duration::from_secs(24 * 3600),
            known_kinds: Job::ALL_KINDS.iter().map(ToString::to_string).collect(),
            auto_retry: true,
        }
    }
}

type Row = (i64, String, i64);

fn section(invariant: &'static str, entity: &'static str, rows: Vec<Row>) -> Option<Section> {
    let count = rows.first().map(|r| r.2)?;
    Some(Section {
        invariant,
        count,
        violations: rows
            .into_iter()
            .map(|(id, detail, _)| Violation {
                invariant,
                entity,
                id,
                detail,
            })
            .collect(),
    })
}

/// Условие «у альбома `$a` (артист `$ar`) есть активный поиск».
macro_rules! active_discover {
    ($a:literal, $ar:literal) => {
        concat!(
            "EXISTS (SELECT 1 FROM jobs j WHERE j.state IN ('queued','running')
                       AND j.dedup_key IN ('discover_album:' || ",
            $a,
            ", 'discover_artist:' || ",
            $ar,
            "))"
        )
    };
}

/// I1. Трек библиотеки в `adding` дольше `grace`, а у альбома нет ни активного поиска
/// (`discover_album`, `discover_artist` артиста), ни `verify_torrent`, ни `process_cue`.
pub async fn i1_adding_without_job(db: &PgPool, grace: Duration) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT a.id, 'tracks in adding: ' || s.n, count(*) OVER ()
         FROM albums a
           JOIN LATERAL (
             SELECT count(*) AS n FROM tracks t
             WHERE t.album_id = a.id AND t.in_library AND t.status = 'adding'
               AND t.updated_at < now() - make_interval(secs => $1)) s ON s.n > 0
         WHERE NOT ",
        active_discover!("a.id", "a.artist_id"),
        "  AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.state IN ('queued','running')
                             AND j.kind IN ('verify_torrent','process_cue')
                             AND j.payload->>'album_id' = a.id::text)
         ORDER BY a.id LIMIT $2"
    ))
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I1", "album", rows))
}

/// I2. Связь альбома с раздачей не проверена, а проверять некому: нет активной `verify_torrent`
/// этой пары и нет активного поиска альбома или его артиста (он ставит проверки сам).
pub async fn i2_unverified_without_job(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT at.album_id, 'torrent_id=' || at.torrent_id, count(*) OVER ()
         FROM album_torrents at JOIN albums a ON a.id = at.album_id
         WHERE NOT at.verified
           AND at.created_at < now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.state IN ('queued','running')
                             AND j.dedup_key = 'verify_torrent:' || at.torrent_id || ':' || at.album_id)
           AND NOT ",
        active_discover!("at.album_id", "a.artist_id"),
        " ORDER BY at.album_id, at.torrent_id LIMIT $2"
    ))
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I2", "album_torrent", rows))
}

/// I3. CUE-образ не разобран, и активной `process_cue` для него нет. Кандидат и его задача
/// создаются одной транзакцией, поэтому `grace` здесь не нужен.
pub async fn i3_cue_without_job(db: &PgPool) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT c.album_id, 'torrent_id=' || c.torrent_id || ' cue_file_index=' || c.cue_file_index,
                count(*) OVER ()
         FROM cue_candidates c
         WHERE NOT c.processed
           AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.state IN ('queued','running')
                             AND j.dedup_key = 'process_cue:' || c.torrent_id || ':' || c.album_id
                                               || ':' || c.cue_file_index)
         ORDER BY c.album_id, c.torrent_id, c.cue_file_index LIMIT $1",
    )
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I3", "cue_candidate", rows))
}

/// I4. У альбома есть `not_found`-треки библиотеки, ничего не ищется, а авто-повтор не назначен
/// (`next_retry_at IS NULL` или нет строки состояния) и поиск не активен. Отсчёт `grace` — от
/// конца последнего поиска, а если его не было — от последнего изменения трека.
pub async fn i4_missing_without_schedule(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "WITH st AS (
            SELECT album_id,
                   count(*) FILTER (WHERE status = 'not_found') AS not_found,
                   count(*) FILTER (WHERE status = 'adding') AS adding,
                   max(updated_at) AS changed_at
            FROM tracks WHERE in_library GROUP BY album_id
         )
         SELECT st.album_id, 'tracks not_found: ' || st.not_found, count(*) OVER ()
         FROM st
           JOIN albums a ON a.id = st.album_id
           LEFT JOIN album_search_state s ON s.album_id = st.album_id
         WHERE st.not_found > 0 AND st.adding = 0
           AND s.next_retry_at IS NULL
           AND COALESCE(s.last_finished_at, st.changed_at) < now() - make_interval(secs => $1)
           AND NOT ",
        active_discover!("st.album_id", "a.artist_id"),
        " ORDER BY st.album_id LIMIT $2"
    ))
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I4", "album", rows))
}

/// I5. Упавшая нефатальная `import_artist` / `discover_artist` — последняя по своему ключу, активной
/// такой же нет, а оживления она ждёт дольше самой длинной паузы (`revive_max`) плюс `grace`.
pub async fn i5_failed_not_revived(
    db: &PgPool,
    grace: Duration,
    revive_max: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT j.id, j.kind || ' ' || COALESCE(j.dedup_key, '') || ': ' || COALESCE(j.last_error, ''),
                count(*) OVER ()
         FROM jobs j
         WHERE j.state = 'failed' AND NOT j.fatal
           AND j.kind IN ('import_artist', 'discover_artist')
           AND j.updated_at < now() - make_interval(secs => $1)
           AND j.id = (SELECT max(x.id) FROM jobs x WHERE x.dedup_key = j.dedup_key)
         ORDER BY j.id LIMIT $2",
    )
    .bind((grace + revive_max).as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I5", "job", rows))
}

/// I6. Задача `running` без heartbeat дольше `stale_after` (+ `grace`): её должен был вернуть `requeue_stale`.
pub async fn i6_running_without_heartbeat(
    db: &PgPool,
    grace: Duration,
    stale_after: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT j.id, j.kind || ' locked by ' || COALESCE(j.locked_by, '?'), count(*) OVER ()
         FROM jobs j
         WHERE j.state = 'running'
           AND COALESCE(j.heartbeat_at, j.locked_at, j.updated_at) < now() - make_interval(secs => $1)
         ORDER BY j.id LIMIT $2",
    )
    .bind((grace + stale_after).as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I6", "job", rows))
}

/// I7. Задача `queued`, которой пора выполняться дольше `grace`, а обработчика её вида нет —
/// её никто не возьмёт. Только отчёт: чинить нечем.
pub async fn i7_queued_without_handler(
    db: &PgPool,
    grace: Duration,
    known_kinds: &[String],
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT j.id, 'no handler for kind ' || j.kind, count(*) OVER ()
         FROM jobs j
         WHERE j.state = 'queued' AND j.run_after < now() - make_interval(secs => $1)
           AND j.kind <> ALL($2)
         ORDER BY j.id LIMIT $3",
    )
    .bind(grace.as_secs_f64())
    .bind(known_kinds)
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I7", "job", rows))
}

/// Ошибки закрепления, после которых авто-повтора нет намеренно: `dead` (все источники без сидов,
/// ждёт нового источника) и постоянные отказы движка (`Failure::Permanent` менеджера загрузок).
const FINAL_PIN_ERRORS: &str = "(p.error = 'dead' OR p.error = 'torrent not found'
      OR p.error LIKE 'invalid magnet:%' OR p.error LIKE 'file index % is out of range')";

/// I8. Закрепление `failed` без расписания повтора и без окончательной причины: оно не повторится никогда.
pub async fn i8_failed_pin_without_schedule(db: &PgPool) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT p.track_id, COALESCE(p.error, 'no error'), count(*) OVER ()
         FROM pinned_tracks p
         WHERE p.state = 'failed' AND p.next_retry_at IS NULL
           AND (p.error IS NULL OR NOT {FINAL_PIN_ERRORS})
         ORDER BY p.track_id LIMIT $1"
    ))
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I8", "pin", rows))
}

/// I9. Закрепление `downloading` дольше `grace`, а строки `downloads` его primary-файла нет:
/// переход трека в `ready` не наступит.
pub async fn i9_downloading_without_row(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT p.track_id,
                COALESCE('torrent_id=' || ts.torrent_id || ' file_index=' || ts.file_index, 'no primary source'),
                count(*) OVER ()
         FROM pinned_tracks p
           LEFT JOIN track_sources ts ON ts.track_id = p.track_id AND ts.is_primary
         WHERE p.state = 'downloading'
           AND p.updated_at < now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM downloads d
                           WHERE d.torrent_id = ts.torrent_id AND d.file_index = ts.file_index)
         ORDER BY p.track_id LIMIT $2",
    )
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I9", "pin", rows))
}

/// I10. Закрепление `waiting_source` дольше `grace`, хотя источник у трека уже есть (`found`/`ready`):
/// менеджер загрузок должен был перевести его в `queued`.
pub async fn i10_waiting_with_source(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT p.track_id, 'track is ' || t.status, count(*) OVER ()
         FROM pinned_tracks p JOIN tracks t ON t.id = p.track_id
         WHERE p.state = 'waiting_source' AND t.status IN ('found', 'ready')
           AND EXISTS (SELECT 1 FROM track_sources ts WHERE ts.track_id = p.track_id AND ts.is_primary)
           AND GREATEST(p.updated_at, t.updated_at) < now() - make_interval(secs => $1)
         ORDER BY p.track_id LIMIT $2",
    )
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I10", "pin", rows))
}

/// I11. Файл докачан (`completed_at`), а трек, у которого он primary, дольше `grace` остаётся `found`.
pub async fn i11_completed_but_found(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT t.id, 'torrent_id=' || d.torrent_id || ' file_index=' || d.file_index, count(*) OVER ()
         FROM downloads d
           JOIN track_sources ts ON ts.torrent_id = d.torrent_id AND ts.file_index = d.file_index
                                AND ts.is_primary
           JOIN tracks t ON t.id = ts.track_id
         WHERE d.completed_at IS NOT NULL AND t.status = 'found'
           AND GREATEST(d.completed_at, t.updated_at) < now() - make_interval(secs => $1)
         ORDER BY t.id LIMIT $2",
    )
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I11", "track", rows))
}

/// I12. Артист в библиотеке дольше `grace` без единого альбома и без задачи `import_artist`
/// в любом состоянии (завершённая или упавшая задача — уже ответ: импорт был или ждёт оживления).
pub async fn i12_artist_without_import(
    db: &PgPool,
    grace: Duration,
) -> sqlx::Result<Option<Section>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT a.id, a.name, count(*) OVER ()
         FROM artists a
         WHERE a.in_library
           AND COALESCE(a.added_at, a.created_at) < now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedup_key = 'import_artist:' || a.id)
         ORDER BY a.id LIMIT $2",
    )
    .bind(grace.as_secs_f64())
    .bind(MAX_VIOLATIONS)
    .fetch_all(db)
    .await?;
    Ok(section("I12", "artist", rows))
}

/// Проверяет все инварианты; в отчёте — только нарушенные.
pub async fn check_all(db: &PgPool, p: &Params) -> sqlx::Result<Report> {
    let g = p.grace;
    let mut sections = Vec::new();
    sections.extend(i1_adding_without_job(db, g).await?);
    sections.extend(i2_unverified_without_job(db, g).await?);
    sections.extend(i3_cue_without_job(db).await?);
    if p.auto_retry {
        sections.extend(i4_missing_without_schedule(db, g).await?);
    }
    sections.extend(i5_failed_not_revived(db, g, p.revive_max).await?);
    sections.extend(i6_running_without_heartbeat(db, g, p.stale_after).await?);
    sections.extend(i7_queued_without_handler(db, g, &p.known_kinds).await?);
    sections.extend(i8_failed_pin_without_schedule(db).await?);
    sections.extend(i9_downloading_without_row(db, g).await?);
    sections.extend(i10_waiting_with_source(db, g).await?);
    sections.extend(i11_completed_but_found(db, g).await?);
    sections.extend(i12_artist_without_import(db, g).await?);
    Ok(Report {
        checked_at: Utc::now(),
        grace_secs: g.as_secs(),
        total: sections.iter().map(|s| s.count).sum(),
        sections,
    })
}
