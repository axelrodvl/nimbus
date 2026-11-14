//! Приобретение альбомов (шаг 32): состояние поиска раздач (`album_search_state`), вычисляемое
//! состояние «приобретения» по трекам и выборки для экрана «Загрузки».

use chrono::{DateTime, Utc};
use nimbus_core::model::{AcquisitionState, NotFoundReason, SearchOutcome};
use serde_json::Value;
use sqlx::{PgConnection, PgExecutor};

/// Не больше стольких альбомов за один массовый повтор.
pub const MAX_BULK_RETRY: i64 = 5000;
/// Предел страницы списка приобретения.
pub const MAX_PAGE: i64 = 200;

/// Причины `not_found` по убыванию приоритета; `reason_rank` в SQL — индекс в этом массиве (с 1).
macro_rules! reasons {
    () => {
        "ARRAY['search_failed','no_torrents','dead_torrents','no_match']"
    };
}

/// Таблица `st`: по строке на альбом с треками в библиотеке — счётчики статусов, прогресс активной
/// загрузки и вычисленное `state`. Приоритет: searching > downloading > partial > missing >
/// available > downloaded. «Активная загрузка» — строка `downloads` без `completed_at` у файла,
/// выбранного основным источником трека альбома.
macro_rules! state_cte {
    () => {
        "WITH tr AS (
            SELECT album_id,
                   count(*)::int AS total,
                   (count(*) FILTER (WHERE status = 'adding'))::int AS adding,
                   (count(*) FILTER (WHERE status = 'found'))::int AS found,
                   (count(*) FILTER (WHERE status = 'not_found'))::int AS not_found,
                   (count(*) FILTER (WHERE status = 'ready'))::int AS ready,
                   min(CASE status_reason
                         WHEN 'search_failed' THEN 1 WHEN 'no_torrents' THEN 2
                         WHEN 'dead_torrents' THEN 3 WHEN 'no_match' THEN 4 END)
                       FILTER (WHERE status = 'not_found') AS reason_rank
            FROM tracks WHERE in_library GROUP BY album_id
         ), dl AS (
            SELECT t.album_id, sum(d.bytes_done)::bigint AS bytes_done, sum(d.bytes_total)::bigint AS bytes_total
            FROM tracks t
              JOIN track_sources ts ON ts.track_id = t.id AND ts.is_primary
              JOIN downloads d ON d.torrent_id = ts.torrent_id AND d.file_index = ts.file_index
            WHERE t.in_library AND d.completed_at IS NULL
            GROUP BY t.album_id
         ), pn AS (
            SELECT t.album_id,
                   CASE WHEN bool_or(p.state = 'downloading') THEN 'downloading'
                        WHEN bool_or(p.state = 'queued') THEN 'queued'
                        WHEN bool_or(p.state = 'failed') THEN 'failed'
                        WHEN bool_or(p.state = 'waiting_source') THEN 'waiting_source'
                        ELSE 'done' END AS pin_state,
                   min(p.error) FILTER (WHERE p.state = 'failed') AS pin_error
            FROM pinned_tracks p JOIN tracks t ON t.id = p.track_id
            WHERE t.in_library GROUP BY t.album_id
         ), st AS (
            SELECT tr.*, dl.bytes_done, dl.bytes_total,
                   (pn.album_id IS NOT NULL) AS pinned, pn.pin_state, pn.pin_error,
                   CASE WHEN tr.adding > 0 THEN 'searching'
                        WHEN dl.album_id IS NOT NULL THEN 'downloading'
                        WHEN tr.not_found > 0 AND tr.found + tr.ready > 0 THEN 'partial'
                        WHEN tr.not_found > 0 THEN 'missing'
                        WHEN tr.ready = tr.total THEN 'downloaded'
                        ELSE 'available' END AS state
            FROM tr LEFT JOIN dl USING (album_id) LEFT JOIN pn USING (album_id)
         )"
    };
}

// ------------------------------------------------------------------ состояние поиска

/// Строка `album_search_state`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SearchState {
    pub album_id: i64,
    pub attempts: i32,
    pub last_started_at: Option<DateTime<Utc>>,
    pub last_finished_at: Option<DateTime<Utc>>,
    pub last_outcome: Option<SearchOutcome>,
    pub candidates: i32,
    pub provider_errors: Value,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub auto_retries: i32,
}

pub async fn get_state(
    db: impl PgExecutor<'_>,
    album_id: i64,
) -> sqlx::Result<Option<SearchState>> {
    sqlx::query_as("SELECT * FROM album_search_state WHERE album_id = $1")
        .bind(album_id)
        .fetch_optional(db)
        .await
}

/// Поиск альбома начался: `last_started_at = now()`. Парой к [`finish_search`].
pub async fn mark_search_started(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO album_search_state (album_id, last_started_at) VALUES ($1, now())
         ON CONFLICT (album_id) DO UPDATE SET last_started_at = now()",
    )
    .bind(album_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Запоминает, что дал поиск: число кандидатов и ошибки провайдеров `[{source, error}]`.
/// Итог и расписание повтора ставит [`finish_search`], когда альбом финализирован.
pub async fn record_search_results(
    db: impl PgExecutor<'_>,
    album_id: i64,
    candidates: i32,
    provider_errors: &Value,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO album_search_state (album_id, candidates, provider_errors)
         VALUES ($1, $2, $3)
         ON CONFLICT (album_id) DO UPDATE SET candidates = $2, provider_errors = $3",
    )
    .bind(album_id)
    .bind(candidates)
    .bind(provider_errors)
    .execute(db)
    .await?;
    Ok(())
}

/// Завершает поиск альбома: `attempts += 1`, `last_finished_at`, `last_outcome` (по трекам библиотеки:
/// все найдены — `found`, часть — `partial`, иначе преобладающая причина `not_found`; при её
/// отсутствии — `fallback`), `next_retry_at` с растущей паузой (6 ч, 1 д, 3 д, 7 д, далее 30 д по
/// `auto_retries`; для `found` — `NULL` и `auto_retries = 0`).
///
/// Срабатывает ровно один раз на поиск: только если `last_started_at` позже `last_finished_at`.
/// Вызывать в транзакции с блокировкой строки альбома. `None` — активного поиска не было.
pub async fn finish_search(
    db: impl PgExecutor<'_>,
    album_id: i64,
    fallback: Option<NotFoundReason>,
) -> sqlx::Result<Option<SearchOutcome>> {
    sqlx::query_scalar(concat!(
        "WITH c AS (
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE status IN ('found','ready')) AS ok,
                   min(CASE status_reason
                         WHEN 'search_failed' THEN 1 WHEN 'no_torrents' THEN 2
                         WHEN 'dead_torrents' THEN 3 WHEN 'no_match' THEN 4 END)
                       FILTER (WHERE status = 'not_found') AS reason_rank
            FROM tracks WHERE album_id = $1 AND in_library
         ), o AS (
            SELECT CASE WHEN total > 0 AND ok = total THEN 'found'
                        WHEN ok > 0 THEN 'partial'
                        ELSE COALESCE((",
        reasons!(),
        ")[reason_rank], $2, 'no_match') END AS outcome
            FROM c
         )
         UPDATE album_search_state s SET
            attempts = s.attempts + 1,
            last_finished_at = now(),
            last_outcome = o.outcome,
            next_retry_at = CASE WHEN o.outcome = 'found' THEN NULL ELSE now() +
                CASE s.auto_retries WHEN 0 THEN interval '6 hours' WHEN 1 THEN interval '1 day'
                                    WHEN 2 THEN interval '3 days' WHEN 3 THEN interval '7 days'
                                    ELSE interval '30 days' END END,
            auto_retries = CASE WHEN o.outcome = 'found' THEN 0 ELSE s.auto_retries END
         FROM o
         WHERE s.album_id = $1
           AND s.last_started_at IS NOT NULL
           AND s.last_started_at > COALESCE(s.last_finished_at, '-infinity'::timestamptz)
         RETURNING s.last_outcome"
    ))
    .bind(album_id)
    .bind(fallback.map(|r| r.as_str()))
    .fetch_optional(db)
    .await
}

/// Ручной повтор: авто-повторы начинаются заново (`auto_retries = 0`, расписание сбрасывается —
/// новое поставит завершение поиска).
pub async fn reset_auto_retries(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO album_search_state (album_id) VALUES ($1)
         ON CONFLICT (album_id) DO UPDATE SET auto_retries = 0, next_retry_at = NULL",
    )
    .bind(album_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Всем альбомам `missing`/`partial` назначает авто-повтор «сейчас» (сменились провайдеры).
/// Возвращает число затронутых альбомов.
pub async fn schedule_missing_now(db: impl PgExecutor<'_>) -> sqlx::Result<u64> {
    Ok(sqlx::query(concat!(
        state_cte!(),
        " INSERT INTO album_search_state (album_id, next_retry_at)
          SELECT album_id, now() FROM st WHERE state IN ('missing', 'partial')
          ON CONFLICT (album_id) DO UPDATE SET next_retry_at = now()"
    ))
    .execute(db)
    .await?
    .rows_affected())
}

/// Берёт до `limit` альбомов `missing`/`partial` с наступившим `next_retry_at` для авто-повтора:
/// `auto_retries += 1`, `next_retry_at = NULL` (переустановит завершение поиска). Параллельные
/// вызовы не пересекаются (`SKIP LOCKED`). Просроченные записи альбомов в других состояниях
/// (уже найдены, ищутся) просто сбрасываются. Вызывать в транзакции вместе с постановкой поиска:
/// иначе сбой между ними навсегда снимет альбом с авто-повтора.
pub async fn take_due(tx: &mut PgConnection, limit: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query(concat!(
        state_cte!(),
        " UPDATE album_search_state s SET next_retry_at = NULL
          WHERE s.next_retry_at <= now()
            AND NOT EXISTS (SELECT 1 FROM st WHERE st.album_id = s.album_id
                            AND st.state IN ('missing', 'partial'))"
    ))
    .execute(&mut *tx)
    .await?;
    sqlx::query_scalar(concat!(
        state_cte!(),
        " , due AS (
            SELECT s.album_id FROM album_search_state s
              JOIN st ON st.album_id = s.album_id AND st.state IN ('missing', 'partial')
            WHERE s.next_retry_at <= now()
            ORDER BY s.next_retry_at, s.album_id
            LIMIT $1
            FOR UPDATE OF s SKIP LOCKED
          )
          UPDATE album_search_state s
          SET auto_retries = s.auto_retries + 1, next_retry_at = NULL
          FROM due WHERE s.album_id = due.album_id
          RETURNING s.album_id"
    ))
    .bind(limit)
    .fetch_all(&mut *tx)
    .await
}

// ------------------------------------------------------------------ выборки

/// Альбом в списке приобретения.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AcquisitionRow {
    pub album_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub artist_id: i64,
    pub artist_name: String,
    pub state: AcquisitionState,
    pub total: i32,
    pub adding: i32,
    pub found: i32,
    pub not_found: i32,
    pub ready: i32,
    /// Преобладающая причина `not_found`-треков.
    pub reason: Option<String>,
    pub attempts: i32,
    pub last_finished_at: Option<DateTime<Utc>>,
    pub last_outcome: Option<SearchOutcome>,
    pub candidates: i32,
    pub provider_errors: Value,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub bytes_done: Option<i64>,
    pub bytes_total: Option<i64>,
    /// Есть закрепления у треков альбома из библиотеки.
    pub pinned: bool,
    /// Агрегат закреплений: downloading > queued > failed > waiting_source > done.
    pub pin_state: Option<nimbus_core::model::PinState>,
    pub pin_error: Option<String>,
    /// Задачи `discover_album`/`verify_torrent`/`process_cue` альбома в очереди или в работе.
    pub active_jobs: i64,
    /// Позиция для курсора (см. [`Cursor`]).
    pub sort_group: i32,
    pub sort_finished: String,
}

/// Позиция в упорядочении «ищется → давно законченные»: (`group`, `finished DESC`, `album_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    group: i32,
    /// Текст `timestamptz` (`-infinity` — поиска не было).
    finished: String,
    album_id: i64,
}

impl Cursor {
    /// Непрозрачная строка для клиента.
    pub fn encode(&self) -> String {
        let raw = format!("{}|{}|{}", self.group, self.finished, self.album_id);
        raw.bytes().map(|b| format!("{b:02x}")).collect()
    }

    /// Разбирает [`Cursor::encode`]; `None` — строка испорчена.
    pub fn decode(s: &str) -> Option<Self> {
        if s.is_empty() || !s.len().is_multiple_of(2) || s.len() > 256 || !s.is_ascii() {
            return None;
        }
        let bytes: Option<Vec<u8>> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
            .collect();
        let raw = String::from_utf8(bytes?).ok()?;
        let mut it = raw.splitn(3, '|');
        let group: i32 = it.next()?.parse().ok()?;
        let finished = it.next()?.to_string();
        let album_id: i64 = it.next()?.parse().ok()?;
        // Время идёт в SQL как `::timestamptz`: допускаем только безопасные символы.
        let ok = finished == "-infinity"
            || (!finished.is_empty()
                && finished
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | ' ' | '+')));
        (ok && (group == 0 || group == 1)).then_some(Self {
            group,
            finished,
            album_id,
        })
    }
}

impl From<&AcquisitionRow> for Cursor {
    fn from(r: &AcquisitionRow) -> Self {
        Self {
            group: r.sort_group,
            finished: r.sort_finished.clone(),
            album_id: r.album_id,
        }
    }
}

/// Страница списка.
#[derive(Debug)]
pub struct AcquisitionPage {
    pub items: Vec<AcquisitionRow>,
    pub next: Option<Cursor>,
}

/// Список альбомов с вычисленным состоянием: сначала `searching`, затем по `last_finished_at DESC NULLS LAST`,
/// `album_id`. `states` — фильтр (`None` — все). Курсорная пагинация: страницы не пересекаются.
pub async fn list(
    db: impl PgExecutor<'_>,
    states: Option<&[AcquisitionState]>,
    cursor: Option<&Cursor>,
    limit: i64,
) -> sqlx::Result<AcquisitionPage> {
    list_filtered(db, states, None, cursor, limit).await
}

/// То же, что [`list`], с необязательным фильтром по `album_ids` (`None` — все альбомы): клиент узнаёт состояние
/// нескольких конкретных альбомов, не листая весь список.
pub async fn list_filtered(
    db: impl PgExecutor<'_>,
    states: Option<&[AcquisitionState]>,
    album_ids: Option<&[i64]>,
    cursor: Option<&Cursor>,
    limit: i64,
) -> sqlx::Result<AcquisitionPage> {
    let limit = limit.clamp(1, MAX_PAGE);
    let states: Option<Vec<&str>> = states.map(|s| s.iter().map(|s| s.as_str()).collect());
    let mut items: Vec<AcquisitionRow> = sqlx::query_as(concat!(
        state_cte!(),
        ", base AS (
            SELECT st.*,
                   (st.state <> 'searching')::int AS sort_group,
                   COALESCE(s.last_finished_at, '-infinity'::timestamptz) AS sort_fin,
                   COALESCE(s.attempts, 0) AS attempts,
                   s.last_finished_at, s.last_outcome,
                   COALESCE(s.candidates, 0) AS candidates,
                   COALESCE(s.provider_errors, '[]'::jsonb) AS provider_errors,
                   s.next_retry_at
            FROM st LEFT JOIN album_search_state s ON s.album_id = st.album_id
            WHERE ($1::text[] IS NULL OR st.state = ANY($1))
              AND ($6::bigint[] IS NULL OR st.album_id = ANY($6))
         ), page AS (
            SELECT * FROM base
            WHERE $2::int IS NULL
               OR sort_group > $2
               OR (sort_group = $2 AND (sort_fin < $3::timestamptz
                                        OR (sort_fin = $3::timestamptz AND album_id > $4)))
            ORDER BY sort_group, sort_fin DESC, album_id
            LIMIT $5
         )
         SELECT p.album_id, a.title, a.year, a.cover_url, a.artist_id, ar.name AS artist_name,
                p.state, p.total, p.adding, p.found, p.not_found, p.ready,
                (",
        reasons!(),
        ")[p.reason_rank] AS reason,
                p.attempts, p.last_finished_at, p.last_outcome, p.candidates, p.provider_errors,
                p.next_retry_at, p.bytes_done, p.bytes_total,
                p.pinned, p.pin_state, p.pin_error,
                (SELECT count(*) FROM jobs j
                  WHERE j.state IN ('queued','running')
                    AND j.payload->>'album_id' = p.album_id::text
                    AND j.kind IN ('discover_album','verify_torrent','process_cue')) AS active_jobs,
                p.sort_group, p.sort_fin::text AS sort_finished
         FROM page p
           JOIN albums a ON a.id = p.album_id
           JOIN artists ar ON ar.id = a.artist_id
         ORDER BY p.sort_group, p.sort_fin DESC, p.album_id"
    ))
    .bind(states)
    .bind(cursor.map(|c| c.group))
    .bind(cursor.map(|c| c.finished.clone()))
    .bind(cursor.map(|c| c.album_id))
    .bind(limit + 1)
    .bind(album_ids)
    .fetch_all(db)
    .await?;
    let next = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items.last().map(Cursor::from)
    } else {
        None
    };
    Ok(AcquisitionPage { items, next })
}

/// Сколько альбомов в каждом состоянии.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub searching: i64,
    pub missing: i64,
    pub partial: i64,
    pub available: i64,
    pub downloading: i64,
    pub downloaded: i64,
}

pub async fn summary(db: impl PgExecutor<'_>) -> sqlx::Result<Summary> {
    let rows: Vec<(AcquisitionState, i64)> = sqlx::query_as(concat!(
        state_cte!(),
        " SELECT state, count(*) FROM st GROUP BY state"
    ))
    .fetch_all(db)
    .await?;
    let mut s = Summary::default();
    for (state, n) in rows {
        match state {
            AcquisitionState::Searching => s.searching = n,
            AcquisitionState::Missing => s.missing = n,
            AcquisitionState::Partial => s.partial = n,
            AcquisitionState::Available => s.available = n,
            AcquisitionState::Downloading => s.downloading = n,
            AcquisitionState::Downloaded => s.downloaded = n,
        }
    }
    Ok(s)
}

/// ID альбомов в заданных состояниях (по возрастанию), не больше `limit`.
pub async fn ids_in_states(
    db: impl PgExecutor<'_>,
    states: &[AcquisitionState],
    limit: i64,
) -> sqlx::Result<Vec<i64>> {
    let states: Vec<&str> = states.iter().map(|s| s.as_str()).collect();
    sqlx::query_scalar(concat!(
        state_cte!(),
        " SELECT album_id FROM st WHERE state = ANY($1) ORDER BY album_id LIMIT $2"
    ))
    .bind(states)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// Существующие среди `ids` альбомы.
pub async fn existing_albums(db: impl PgExecutor<'_>, ids: &[i64]) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT id FROM albums WHERE id = ANY($1) ORDER BY id")
        .bind(ids)
        .fetch_all(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip_and_rejects_garbage() {
        let c = Cursor {
            group: 1,
            finished: "2026-11-14 10:00:00.123456+00".into(),
            album_id: 42,
        };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        let inf = Cursor {
            group: 0,
            finished: "-infinity".into(),
            album_id: 1,
        };
        assert_eq!(Cursor::decode(&inf.encode()), Some(inf));
        for bad in ["", "zz", "abc", "00"] {
            assert_eq!(Cursor::decode(bad), None, "{bad:?}");
        }
        let hex = |s: &str| -> String { s.bytes().map(|b| format!("{b:02x}")).collect() };
        assert_eq!(
            Cursor::decode(&hex("1|2026'; DROP|5")),
            None,
            "кавычки недопустимы"
        );
        assert_eq!(
            Cursor::decode(&hex("7|-infinity|5")),
            None,
            "группа вне 0..=1"
        );
        assert_eq!(Cursor::decode(&hex("1|-infinity|x")), None);
        assert_eq!(Cursor::decode(&hex("1|-infinity")), None);
    }
}

#[cfg(test)]
mod cursor_props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn encode_decode_is_identity(
            group in 0i32..=1,
            finished in prop_oneof![Just("-infinity".to_string()), "[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]{8}\\+00"],
            album_id in any::<i64>(),
        ) {
            let c = Cursor { group, finished, album_id };
            prop_assert_eq!(Cursor::decode(&c.encode()), Some(c));
        }

        #[test]
        fn garbage_never_panics(s in ".{0,300}") {
            let _ = Cursor::decode(&s);
        }

        /// Валидный hex чужого содержимого не пропускает опасные символы во время.
        #[test]
        fn hex_of_arbitrary_text_is_safe(raw in ".{0,80}") {
            let hex: String = raw.bytes().map(|b| format!("{b:02x}")).collect();
            if let Some(c) = Cursor::decode(&hex) {
                prop_assert!(c.finished == "-infinity" || c.finished.chars().all(|ch| ch.is_ascii_digit() || "-:. +".contains(ch)));
            }
        }
    }
}
