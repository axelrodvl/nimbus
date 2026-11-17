# B15 — Закрепление `dead` не оживает никогда; постоянный отказ источника не переключает на другой

**Приоритет:** P1 · **Область:** `backend/crates/api` (`download_manager.rs`, `stream.rs`), `backend/crates/db` (`pins.rs`, `album_torrents.rs`, `invariants.rs`), `backend/crates/worker` (`discover.rs`) · **Зависит от:** B04, B14

## Проблема

Найдено при выполнении B14 (чтение `download_manager.rs` и хаос-тест `api/tests/convergence.rs`). Четыре дыры в
одном месте — «источник закреплённого трека не отдаёт данные»:

1. **`dead` — навсегда.** После шести циклов «нет сидов» (`stalled_pauses`, ≈ 3 суток) закрепление получает
   `failed("dead")` с `next_retry_at = NULL`. `README.md` обещает, что оно «оживает при появлении нового источника
   (его ищет фоновый поиск альбома)», но такого поиска нет: новый поиск запрашивает только `give_up_source`
   (`request_new_sources`), а он вызывается лишь пока идут циклы `stalled`. Треки альбома при этом `found`, значит
   альбом не попадает и в `RetryMissing`. Итог: раздающий вернулся через неделю — трек не скачается никогда, пока
   пользователь не нажмёт «Повторить». Это противоречит цели ревью («без участия пользователя»).
2. **Постоянный отказ источника (`Failure::Permanent`) не пробует другой источник.** `apply_failure` сразу делает
   `fail(p, message, None, false)`: неверный magnet или индекс файла у одной раздачи навсегда останавливает
   закрепление, даже если у трека есть вторая, рабочая раздача. Новый поиск тоже не запрашивается.
3. **«Мёртвые» раздачи альбома не перепроверяются.** `request_new_sources` ставит `discover_album`, но тот проверяет
   только *новые* связи. Раздача альбома, которую раньше не удалось проверить (`torrents.meta_status` =
   `dead`/`timeout`/`error`: раздающий был офлайн в день поиска), остаётся «проверенной без файлов» и вторым
   источником не станет. `reset_dead` вызывается только из `retry_album_in` (ручной повтор и `RetryMissing`).
4. **Медленное обнаружение.** Зависание признаётся через `stall_timeout` = 10 минут, затем обязательный перезапуск
   того же источника и ещё 10 минут — 20 минут до перехода на соседнюю раздачу, даже когда у торрента ноль пиров.
   И `next_source` (`stream.rs`) никогда не выбирает CUE-источник — для загрузки на сервер это ограничение лишнее
   (оно нужно стримингу: переключение внутри ответа).

## Текущее состояние (прочитай перед началом)

- `backend/crates/api/src/download_manager.rs` — `tick` (блок «Зависание»), `is_stalled`, `apply_failure`,
  `give_up_source`, `request_new_sources`, `ManagerConfig`.
- `backend/crates/api/src/stream.rs` — `next_source`, `switch_to_next_source`, `failover`.
- `backend/crates/db/src/repo/pins.rs` — `fail`, `retry_failed`, `requeue_stalled_for_tracks`, `album_needs_sources`.
- `backend/crates/db/src/repo/album_torrents.rs` — `reset_dead`.
- `backend/crates/worker/src/discover.rs` — `discover_album` (`needs_search`, `enqueue_verifies`).
- `backend/crates/db/src/repo/invariants.rs` — `i8_failed_pin_without_schedule`, `FINAL_PIN_ERRORS`.
- Тесты: `backend/crates/api/tests/download_manager.rs`, `api/tests/convergence.rs`, `db/tests/invariants.rs`.

## Что сделать

1. **`dead` повторяется без конца, но редко.** В `give_up_source`, когда циклы `stalled_pauses` исчерпаны,
   закрепление получает `failed("dead")` **с расписанием**: `next_retry_at = now() + dead_pause`
   (`ManagerConfig::dead_pause`, по умолчанию 24 ч). Счётчик `retries` дальше не растёт (иначе переполнится через
   годы): `pins::fail(…, count = false)`. Каждый такой повтор — обычный цикл: запуск, зависание, смена источника.
   `request_new_sources` вызывается и для `dead` (сейчас так и есть — оставить).
2. **Постоянный отказ → следующий источник.** В `apply_failure` для `Failure::Permanent`: пометить источник
   опробованным и вызвать ту же смену источника, что и для `NoPeers` (вынести общую часть `give_up_source` в
   функцию «переключиться или вернуть `false`»). Если переключаться некуда — `failed(<сообщение>)` с
   `next_retry_at = now() + dead_pause` и `request_new_sources` (после нового поиска primary может смениться).
   Закрепление без расписания после этой задачи не остаётся ни в одной ветке.
3. **Перепроверка мёртвых раздач при запросе новых источников.** `request_new_sources` в одной транзакции:
   `album_torrents::reset_dead(album_id)` (связи снова непроверены, `meta_status = pending`, попытки с нуля) и
   постановка `discover_album` (`PRIORITY_BACKGROUND`). Ограничение частоты (`discover_interval`, 6 ч) остаётся.
   `discover_album` уже ставит `verify_torrent` всем непроверенным связям (`enqueue_verifies` после первой волны) —
   проверить тестом, что это работает и когда поиск ничего нового не нашёл.
4. **Быстрое обнаружение.**
   - `ManagerConfig::stall_timeout_no_peers` (по умолчанию 3 мин): если `file_progress` сообщает `peers == 0`
     (или прогресса нет вовсе) дольше этого времени — источник считается зависшим; обычный `stall_timeout`
     (10 мин) остаётся для случая «пиры есть, байты не идут».
   - Перезапуск того же источника перед сменой — только если движок потерял торрент (`file_progress == None`);
     при живом торренте без данных сразу `give_up_source`.
   - Менеджер загрузок выбирает следующий источник с учётом CUE: добавить `next_source` параметр
     `allow_cue: bool` (стриминг — `false`, менеджер — `true`).
5. **Инвариант I8.** `i8_failed_pin_without_schedule` упростить: нарушение — любое `failed` с
   `next_retry_at IS NULL` (константа `FINAL_PIN_ERRORS` удаляется). Обновить строку I8 и абзац «Что отчёт не
   считает нарушением» в `docs/operations.md`, строку «Закрепление `failed`» и список «Что остаётся остановленным
   намеренно» в `docs/review/README.md` (пункт про `dead` — заменить на «повторяется раз в сутки»).
6. **Миграция** `00NN_pin_dead_retry.sql` (следующий свободный номер): существующим `failed` с
   `next_retry_at IS NULL` назначить `next_retry_at = now()` — после обновления всё пробуется заново.

## Тесты (обязательные)

`api/tests/download_manager.rs` (фейковый `FileProvider`, малые паузы в `ManagerConfig`):

- `dead_pin_is_retried_after_dead_pause`: закрепление доходит до `dead`, имеет `next_retry_at`; после наступления
  времени снова `queued` → при появившемся прогрессе доходит до `done`.
- `permanent_failure_switches_to_another_source`: `ensure_files` первого источника → `InvalidFileIndex`, у трека
  есть второй источник → primary сменился, закрепление `queued`/`downloading`, не `failed`.
- `permanent_failure_without_alternatives_is_scheduled_and_requests_sources`: `failed` с `next_retry_at`,
  в очереди `discover_album`.
- `stalled_pin_resets_dead_torrents_of_the_album`: у альбома есть раздача `meta_status = dead`, связь `verified`;
  после зависания единственного источника раздача `pending`, связь непроверена, `discover_album` в очереди.
- `no_peers_stall_is_detected_by_the_short_timeout`, `live_torrent_without_data_skips_the_restart`,
  `cue_source_is_used_as_a_fallback_for_a_pin`.

`db/tests/invariants.rs`: обновить пару тестов I8 (окончательных причин больше нет: `dead` без расписания — нарушение).

`api/tests/convergence.rs`: убрать из конфигурации менеджера длинный список `stalled_pauses` (сейчас он обходит
дыру 1) — задать две короткие паузы и `dead_pause` 200 мс; сценарий должен сходиться, проходя через `dead`.
20 прогонов подряд зелёные.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov`, `just docs-check` зелёные.
- В `docs/review/README.md`: `[x]`, строка Журнала.

## Не входит

- Изменение расписаний поиска альбома (`RetryMissing`).
- Поведение стриминга при смене источника.
