# B09 — Сбой части провайдеров при непустой выдаче → повтор только через 6 часов

**Приоритет:** P2 · **Область:** `backend/crates/db` (`acquisition.rs`), `backend/crates/worker` (`discover.rs`) · **Зависит от:** —

## Проблема

`discover_album` считает поиск «неубедительным» (`inconclusive` → повтор задачи / `Defer`) только когда у альбома
**нет ни одной привязанной раздачи**. Если один провайдер ответил ошибкой, а другой вернул хоть что-то (включая
неподходящие раздачи), поиск считается состоявшимся: раздачи проверяются, не подошли → `not_found(no_match)` или
`dead_torrents`, и `finish_search` ставит обычное «длинное» расписание: 6 ч, сутки, 3 дня, 7 дней, 30 дней.

Но ответ «не найдено» здесь неполный: не ответивший провайдер мог иметь нужную раздачу. Короткое расписание
(10 мин, 30 мин, 2 ч, 6 ч, сутки) сейчас применяется только к итогу `search_failed`.

Ошибки последнего поиска уже сохраняются: `album_search_state.provider_errors` (`record_search_results`).

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/acquisition.rs` — `record_search_results`, `finish_search` (два расписания в `CASE`).
- `backend/crates/worker/src/discover.rs` — `inconclusive`, `discover_album`, `SearchOutcome::provider_errors_json`.
- Тесты: `backend/crates/db/tests/acquisition.rs` (расписания), `backend/crates/worker/tests/discover.rs`.

## Что сделать

1. В `finish_search` выбирать короткое расписание, когда итог не `found` **и** (итог `search_failed`
   **или** `s.provider_errors <> '[]'::jsonb`). Сам `last_outcome` не менять (`no_match` остаётся `no_match` —
   интерфейс показывает причину и ошибки провайдеров отдельно).
2. Ошибки вида «провайдер отключён предохранителем» (`ProviderError::CircuitOpen`) тоже считаются ошибками —
   отдельной обработки не нужно.
3. `record_search_results` перезаписывает `provider_errors` на каждом поиске — успешный следующий поиск очищает их,
   и расписание возвращается к длинному. Проверить, что повтор задачи поиска (несколько попыток одной задачи)
   оставляет ошибки **последней** попытки — так и есть, зафиксировать тестом.
4. Обновить doc-комментарий `finish_search` и описание расписаний в `docs/operations.md` (если оно там есть).

## Тесты (обязательные)

`db/tests/acquisition.rs`:

- `partial_provider_failure_uses_short_schedule`: `record_search_results(candidates = 3, errors = [{…}])`,
  треки `not_found(no_match)` → `finish_search` ставит `next_retry_at ≈ now() + 10 minutes`, `last_outcome = 'no_match'`.
- `clean_no_match_uses_long_schedule`: то же с `errors = []` → `≈ now() + 6 hours`.
- `partial_outcome_with_errors_uses_short_schedule`: итог `partial` + ошибки → короткое.
- `found_clears_schedule_regardless_of_errors`.

`worker/tests/discover.rs`:

- `provider_error_with_other_results_schedules_quick_retry`: два фейковых провайдера (один — ошибка, второй — раздача,
  не совпадающая с альбомом), после `discover_album` + `verify_torrent` альбом `not_found`, `next_retry_at` в пределах
  15 минут.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.

## Не входит

- Повтор запроса к упавшему провайдеру внутри той же задачи (уже есть в `ProviderRegistry`).
