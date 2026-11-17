# B16 — После запуска новой версии всё отложенное пробуется сразу; очередь авто-повторов разбирается без пауз

**Приоритет:** P1 · **Область:** `backend/crates/db` (`acquisition.rs`, `jobs.rs`, `pins.rs`, `settings.rs`), `backend/crates/worker` (`runner.rs`, `acquisition.rs`), `backend/crates/api` (`main.rs`) · **Зависит от:** B14 (B15 желательна)

## Проблема

Цель владельца: «открыть библиотеку с кучей проблем, запустить на ней новую версию, ничего не делать руками и
получить музыку». После B01–B14 всё действительно доводится до конца, но **по старым расписаниям**:

1. Альбом, не найденный месяц назад, имеет `next_retry_at` до 30 дней вперёд; закрепление в цикле `stalled` — до
   суток; упавший импорт артиста — до суток. Новая версия (исправленный matcher, провайдеры, очередь) могла бы
   найти всё сразу, но ждёт своих же старых пауз.
2. Первый `RetryMissing` после старта ставится только через `retry_missing_interval` (5 минут): `MaintClock`
   инициализирует `retry_missing` текущим моментом.
3. `RetryMissing` берёт `BATCH` = 200 альбомов за запуск, запуск — раз в 5 минут: 3 000 просроченных альбомов
   встают в очередь поиска 75 минут, хотя сама очередь (`discover_workers`, лимитеры провайдеров) свободна
   (backlog B5).
4. Альбом с `not_found`-треками, потерявший расписание, усыновляется (`adopt_orphans`) только если последний поиск
   закончился больше 6 часов назад — до этого он висит в отчёте инвариантов (I4) и не ищется.
5. `finish_search` создаёт расписание «без начатого поиска» только при `last_started_at IS NULL`. Если поиск когда-то
   начинался, а нынешняя задача упала до `mark_search_started` (исчерпание попыток из-за падений процесса,
   `requeue_stale`), расписание после `take_due` остаётся `NULL` — альбом снова сирота (см. п. 4).
6. В списке «Фоновые задачи» копятся нефатальные `failed` видов `discover_album` / `verify_torrent` / `process_cue`,
   которые никто не заменил (например, проверка резервной мёртвой раздачи): `purge_failed` удаляет только
   фатальные и вытесненные.

## Текущее состояние (прочитай перед началом)

- `backend/crates/api/src/main.rs` — порядок запуска (`WorkerPool::start`, `reconcile_downloads`, менеджер загрузок).
- `backend/crates/worker/src/runner.rs` — `WorkerPool::start`, `MaintClock`, `enqueue_periodic_step`, `revive_step`.
- `backend/crates/worker/src/acquisition.rs` — `RetryMissingHandler`, `BATCH`.
- `backend/crates/db/src/repo/acquisition.rs` — `schedule_missing_now`, `take_due`, `adopt_orphans`, `finish_search`.
- `backend/crates/db/src/repo/jobs.rs` — `revive_failed`, `purge_failed`, `enqueue` (флаг `rerun` у выполняющейся задачи).
- `backend/crates/db/src/repo/pins.rs` — `retry_failed`; `backend/crates/db/src/settings.rs` — таблица `settings`
  (ключ `runtime`, см. `downloads_paused`).
- Тесты: `db/tests/acquisition.rs`, `db/tests/jobs.rs`, `worker/tests/retry_missing.rs`, `worker/tests/runner.rs`.

## Что сделать

1. **Отметка версии.** В `settings.runtime` хранить `last_version` (`nimbus_db::settings::last_version` /
   `set_last_version`, по образцу `downloads_paused`). В `main.rs` после миграций и до `WorkerPool::start`:
   если сохранённая версия отличается от `CARGO_PKG_VERSION` (или отметки нет, а в БД есть хоть один артист в
   библиотеке) — выполнить «рывок восстановления» (п. 2) и записать новую версию. Обычный рестарт той же версии
   рывок **не** делает: иначе crash-loop каждый раз заново опрашивал бы провайдеры по всей библиотеке.
   В лог — `info` с числами по каждому пункту.
2. **Рывок восстановления** — одна функция `nimbus_db::repo::recovery::kick(db, max_crashes) -> KickReport`
   (новый модуль, одна транзакция):
   - альбомам, которым нужен повтор (то же условие, что у `schedule_missing_now`): `next_retry_at = now()`,
     `auto_retries = 0` — лестница пауз начинается заново;
   - закреплениям `failed` (любая причина): `state = 'queued'`, `error = NULL`, `retries = 0`,
     `next_retry_at = NULL`;
   - задачам `failed` с `fatal = FALSE` видов `import_artist` / `discover_artist`, последним по своему ключу и без
     активной такой же, с `crashes < max_crashes`: в очередь сейчас (`attempts = 0`, `revivals = 0`,
     `run_after = now()`), с `pg_notify`. Задачи, ронявшие процесс (`crashes >= max_crashes`), не трогать —
     их оживит обычный `revive_failed` по расписанию;
   - артистам из `artists::without_import(grace = 0)` — постановка импорта.
3. **Первый `RetryMissing` сразу.** `MaintClock::retry_missing` инициализировать так, чтобы первый тик обслуживания
   поставил задачу (как сделано для `purge`).
4. **Разбор очереди авто-повторов без пауз.** В `RetryMissingHandler`: если `take_due` вернул полную порцию
   (`ids.len() == BATCH`), после коммита поставить `Job::RetryMissing` ещё раз (`jobs::enqueue` — у выполняющейся
   задачи это выставит `rerun`, и она запустится снова сразу после завершения). Порция остаётся 200: транзакция
   короткая, темп поиска задают воркеры и лимитеры провайдеров. Удалить запись B5 из `docs/backlog.md`.
5. **Сироты усыновляются сразу.** В `adopt_orphans` убрать условие `last_finished_at < now() - interval '6 hours'`.
   Зацикливание исключает п. 6: после любого завершённого поиска расписание есть.
6. **`finish_search` не теряет расписание.** Во второй ветке `WHERE` у `ON CONFLICT` заменить
   `s.last_started_at IS NULL AND s.next_retry_at IS NULL AND EXCLUDED.last_outcome <> 'found'` на
   `s.next_retry_at IS NULL AND EXCLUDED.last_outcome <> 'found'`. Повторные вызовы `finalize` по-прежнему ничего не
   пишут: после первого расписание уже не `NULL`. Проверить существующие тесты «срабатывает один раз на поиск»;
   тест, который закрепляет старое поведение для «начатого и законченного поиска без расписания», переписать под
   новое (расписание создаётся) и указать это в Журнале.
7. **Уборка.** `purge_failed`: кроме фатальных и вытесненных удалять нефатальные `failed` старше `failed_retention`
   тех видов, которые обслуживание не оживляет (всё, кроме `import_artist` / `discover_artist` — список передавать
   параметром из `REVIVABLE_KINDS`).
8. `docs/operations.md`: абзац «Обновление версии» — что происходит при первом запуске новой версии; таблица
   «Застрявшие состояния», строка I4 — «каждые 5 минут, без ожидания».

## Тесты (обязательные)

`db/tests/recovery.rs` (новый):

- `kick_restarts_schedules_pins_and_failed_jobs`: альбом `not_found` с расписанием через 20 дней и
  `auto_retries = 4`; закрепления `failed("stalled")` с расписанием и `failed("dead")` без него; упавший нефатальный
  импорт → после `kick` всё «сейчас», счётчики обнулены, отчёт содержит числа.
- `kick_skips_fatal_and_crash_looping_jobs`, `kick_leaves_found_albums_and_active_jobs_alone`.

`db/tests/settings.rs` или рядом: `last_version` читается/пишется, не затирает `downloads_paused`.

`db/tests/acquisition.rs`: `orphan_is_adopted_right_after_a_finished_search`;
`finish_search_schedules_when_search_never_restarted` (поиск был начат и закончен раньше, расписание `NULL`,
треки `not_found` → расписание создаётся); `repeated_finalize_writes_once` остаётся зелёным.

`db/tests/jobs.rs`: `purge_failed_removes_old_non_revivable_failures`, `…_keeps_revivable_ones`.

`worker/tests/retry_missing.rs`: `full_batch_requeues_itself_until_drained` (2 × `BATCH` + 1 альбомов → три запуска
без ожидания `retry_missing_interval`); `first_retry_missing_runs_on_startup`.

`api/tests` (новый `upgrade.rs` или в `chaos.rs`): `new_version_kicks_everything_once` — функция запуска из `main.rs`
вынесена так, чтобы её можно было вызвать в тесте (`nimbus_api::startup::recover_on_upgrade(db, version)`):
первый вызов делает рывок, второй с той же версией — нет, с другой версией — снова делает.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov`, `just docs-check` зелёные.
- Хаос-тест `api/tests/convergence.rs` зелёный 20 прогонов подряд.
- В `docs/review/README.md`: `[x]`, строка Журнала.

## Не входит

- Автоматический рывок при каждом рестарте (см. п. 1 — осознанно).
- Изменение самих лестниц пауз.
