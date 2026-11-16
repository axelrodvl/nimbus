# B11 — Запрос, пришедший во время выполнения задачи, теряется; постановка задач вне транзакции

**Приоритет:** P1 · **Область:** `backend/crates/db` (`jobs.rs`), `backend/crates/library` (`service.rs`), `backend/crates/worker` · **Зависит от:** B06 (меняет сигнатуру `complete`/`fail`)

## Проблема

### 1. Дедупликация против `running` молча отбрасывает запрос

`jobs::enqueue` не ставит задачу, если с тем же `dedup_key` уже есть `queued` **или `running`**. Для `queued` это
верно — задача ещё прочитает свежие данные. Для `running` — нет: выполняющаяся задача могла уже пройти точку,
где читала то, что изменил запросивший. Запрос потерян, результат не учитывает изменения:

- `add_track` / ручной «Повторить» / `RetryMissing` ставят `discover_album`, пока прежний поиск этого альбома
  уже проверил «искать нечего» или уже опросил провайдеров → трек остаётся `adding` без задачи
  (через 10 минут `finalize_stuck_albums` объявит его `not_found`, следующий шанс — по расписанию через часы);
- `reset_dead` снял `verified`, `enqueue_verifies` ставит `verify_torrent`, а прежняя проверка этой пары ещё
  дописывает итог → новая проверка не состоится;
- `EvictCache` после завершения файла, пока вытеснение уже посчитало занятое место.

### 2. Изменение данных и постановка задачи — разные операции

- `LibraryService::add_track`: `tx.commit()`, затем `jobs::enqueue(DiscoverAlbum)` отдельным запросом.
  Сбой между ними — трек в библиотеке в `adding` без поиска.
- `LibraryService::add_artist`: `set_in_library(true)`, затем `enqueue_import` — без транзакции. Сбой между ними:
  артист в библиотеке без альбомов, а повторное добавление вернёт `Exists` и импорт **не поставит**.

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/jobs.rs` — `enqueue` (CTE `ins` + `bump`), `complete`, `fail`, уникальный индекс
  по `dedup_key WHERE state IN ('queued','running')` (`backend/migrations/0002_schema.sql`).
- `backend/crates/worker/src/runner.rs` — `process`.
- `backend/crates/library/src/service.rs` — `add_track`, `add_artist`, `enqueue_import`, `add_album_inner` (образец:
  постановка внутри транзакции).
- `backend/crates/api/src/library.rs`, `settings.rs` — повторный импорт артиста.
- Тесты: `db/tests/jobs.rs`, `worker/tests/runner.rs`, `api/tests/library.rs`.

## Что сделать

### 1. Флаг «выполнить ещё раз»

Миграция: `ALTER TABLE jobs ADD COLUMN rerun BOOLEAN NOT NULL DEFAULT FALSE;`

- `enqueue`: третья ветка CTE — если вставка не произошла и активная задача с этим ключом `running`:
  `UPDATE jobs SET rerun = TRUE, priority = GREATEST(priority, $6) WHERE dedup_key = $3 AND state = 'running'`.
  Возвращаемое значение не меняется (`None` — новая строка не создана).
- `complete`: `state = CASE WHEN rerun THEN 'queued' ELSE 'done' END`; при повторе — `rerun = FALSE`,
  `attempts = 0`, `run_after = now()`, блокировка снята, `pg_notify('jobs', …)`. Вернуть, была ли задача
  перепоставлена (для лога `debug`).
- Окончательный провал (`fail` → `failed`, `defer` по возрасту) при `rerun = TRUE`: тоже вернуть в `queued`
  с `attempts = 0`, `rerun = FALSE` — новый запрос заслуживает своего цикла попыток; `on_exhausted` в этом случае
  не вызывать (функции возвращают строку — раннер смотрит на её `state`).
- `recover_orphans`, `release_workers`, `release`, `requeue_stale` флаг не трогают (задача и так вернётся в очередь);
  при возврате в `queued` флаг можно сбросить — она прочитает свежие данные.
- Обновить doc-комментарий `enqueue`: «запрос во время выполнения не теряется».

### 2. Постановка в той же транзакции

- `add_track`: `jobs::enqueue(DiscoverAlbum)` перенести внутрь транзакции до `commit` (как в `add_album_inner`).
- `add_artist`: `set_in_library` и `enqueue` импорта — одна транзакция (`enqueue_import` получает исполнителя
  `impl PgExecutor`, либо добавить `enqueue_import_in(&mut tx, …)`).
- Пройти поиском `jobs::enqueue(` по `crates/api` и `crates/library`: каждое место, где задача ставится после
  изменения данных отдельным запросом, перевести на общую транзакцию или обосновать комментарием, почему
  потеря безопасна (например, `EvictCache` — периодически ставится обслуживанием).

### 3. Страховка: артист в библиотеке без импорта

В `maintenance_loop` (раз в час, вместе с уборкой): новая выборка `artists::without_import()` — артисты с
`in_library`, у которых нет ни одного альбома, добавлены больше 15 минут назад и нет задачи
`import_artist:{id}` в состояниях `queued`/`running`/`done`, а также нет `failed` (её оживит B05).
Для каждого — `enqueue_import`, лог `warn`. Артист, добавленный одним треком (без импорта дискографии), имеет альбом
и в выборку не попадает.

## Тесты (обязательные)

`db/tests/jobs.rs`:

- `enqueue_during_running_sets_rerun`; `complete_with_rerun_requeues_with_fresh_attempts` (и шлёт `NOTIFY`);
- `final_failure_with_rerun_requeues`; `enqueue_during_queued_does_not_set_rerun`;
- `rerun_is_cleared_after_requeue` (вторая `complete` даёт `done`).

`worker/tests/runner.rs`: `request_during_run_causes_second_run` — обработчик на первом запуске «пропускает» работу
и ждёт сигнала теста; тест ставит ту же задачу и отпускает обработчик → обработчик вызван дважды, итог `done`.

`worker/tests/discover.rs`: `track_added_during_running_discover_is_searched` — поиск альбома выполняется
(фейковый провайдер держит ответ), в это время добавляется трек и ставится `discover_album` → после завершения
трек не остаётся `adding` без задачи: второй проход поиска состоялся.

`api/tests/library.rs`: `add_artist_is_atomic` / `add_track_is_atomic` (при ошибке постановки данные не изменены —
проверить через сбой, внедрённый в транзакцию, например нарушением ограничения в тестовом триггере, либо
unit-тест на уровне сервиса с закрытым пулом после `begin`); `artist_without_import_gets_import_job`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные (порог `db::repo::jobs` ≥ 95 %).

## Не входит

- Объединение привязки раздач и постановки проверок в `discover_*` в одну транзакцию (закрывает B03).
