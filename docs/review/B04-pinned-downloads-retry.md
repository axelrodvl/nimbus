# B04 — Загрузки на сервер: повторы без «сдаюсь», различие причин, поиск новых источников

**Приоритет:** P1 · **Область:** `backend/crates/api` (`download_manager.rs`), `backend/crates/db`, `backend/crates/worker` · **Зависит от:** —

## Проблема

`DownloadManager` ведёт закрепления (`pinned_tracks`). Сейчас:

1. **Любая неудача — один и тот же `failed` с общим бюджетом.** `retry_failed` повторяет через час и не больше
   5 раз (`ManagerConfig { retry_after: 3600 s, max_retries: 5 }`), после чего закрепление остаётся `failed`
   навсегда. В `failed` попадает всё подряд: зависание без сидов (`"stalled"`), таймаут запуска торрента,
   ошибка хранилища (нет места), и даже **кратковременная ошибка БД** в `start_group`
   (`.map_err(|e| e.to_string())` на `torrents::get`, `downloads::get/upsert`). Секундный сбой БД стоит загрузке
   часа ожидания и одной из пяти попыток.
2. **Мёртвый источник никогда не заменяется новым.** Когда все известные источники трека зависли,
   закрепление → `failed("stalled")`. Новый поиск раздач не запускается: треки остаются `found`, альбом
   в состоянии `available`/`downloading`, `RetryMissing` берёт только альбомы с `not_found`.
3. **Таймаут метаданных при запуске не переключает источник.** `handle_stall` пробует следующий источник,
   а ошибка `ensure_files` (в т. ч. `MetadataTimeout`) сразу даёт `failed` всей группе.
4. Счётчик `retries` не сбрасывается, когда загрузка пошла: медленная раздача, которая иногда замирает,
   исчерпает бюджет, хотя прогресс есть.
5. Карты `stalls` и `tried` в памяти менеджера не чистятся для снятых закреплений (небольшая утечка).

## Текущее состояние (прочитай перед началом)

- `backend/crates/api/src/download_manager.rs` — `ManagerConfig`, `tick`, `is_stalled`, `handle_stall`, `start_group`.
- `backend/crates/db/src/repo/pins.rs` — `retry_failed`, `set_state`, `requeue`, `pin_tracks`, `list_open`.
- `backend/crates/api/src/stream.rs` — `switch_to_next_source`, `next_source`.
- `backend/crates/worker/src/discover.rs` — `discover_album` (условие `needs_search`).
- `backend/migrations/0011_pins.sql`; `backend/crates/api/tests/download_manager.rs`.
- `nimbus_torrent::EngineError` (`backend/crates/torrent/src/lib.rs`).

## Что сделать

### 1. Схема

Миграция `0013_pin_retry.sql`:

```sql
ALTER TABLE pinned_tracks ADD COLUMN next_retry_at TIMESTAMPTZ;  -- когда повторить `failed`; NULL — не повторять
-- Прежние `failed` получают новую жизнь: расписание с нуля.
UPDATE pinned_tracks SET retries = 0, next_retry_at = now() WHERE state = 'failed';
```

### 2. Классификация неудач

В `download_manager.rs` ввести `enum Failure { Transient, NoPeers, Permanent }` и функцию
`classify(&EngineError) -> Failure`:

| Причина | Класс |
|---|---|
| ошибка БД, `EngineError::Io`, `Storage`, `Internal`, «timed out starting the torrent» | `Transient` |
| `MetadataTimeout`, зависание (`is_stalled`) | `NoPeers` |
| `InvalidMagnet`, `InvalidFileIndex`, раздачи нет в БД, путь файла неизвестен | `Permanent` |

`start_group` возвращает `Result<(), (Failure, String)>` вместо `Result<(), String>`.

### 3. Расписание

Новая функция `pins::fail(db, track_id, error, next_retry_at: Option<DateTime<Utc>>, count: bool)`:
`state = 'failed'`, `error`, `next_retry_at`, `retries = retries + (count as int)`.
`pins::retry_failed(db)` — без параметров: `WHERE state = 'failed' AND next_retry_at <= now()` →
`queued`, `error = NULL`, `next_retry_at = NULL`. Поля `retry_after`/`max_retries` в `ManagerConfig` заменить на
расписания (в тестах — малые значения):

- `Transient`: пауза 1, 5, 15 мин, далее 60 мин — **без ограничения числа повторов**, `retries` не растёт
  (номер ступени — счётчик в памяти менеджера по `track_id`, сбрасывается при успехе и рестарте).
  Ошибка БД внутри `tick` для отдельной группы не должна переводить закрепления в `failed` вообще:
  оставить их `queued` и попробовать на следующем тике (логировать `warn`).
- `NoPeers`: сначала следующий источник (`switch_to_next_source`, как в `handle_stall` — вынести общий код).
  Если источников больше нет: `failed("stalled")`, `count = true`, пауза по `retries`: 1 ч, 3 ч, 6 ч, 12 ч, 24 ч, 24 ч.
  После 6-го цикла — `next_retry_at = NULL`, `error = "dead"`: источники явно мертвы. Закрепление оживёт,
  когда у трека появится новый primary (`set_primary` → `pins::requeue`), при повторном закреплении
  (`pin_tracks` уже сбрасывает `failed`) или ручном повторе.
- `Permanent`: `failed`, `next_retry_at = NULL`.

`pins::requeue` и `pin_tracks` при возврате в очередь обнуляют `next_retry_at` и `retries`.

### 4. Сброс бюджета при прогрессе

В `is_stalled`, ветка «байты изменились»: если у закрепления `retries > 0` — `pins::reset_retries(track_id)`
(один UPDATE, только при `retries > 0`). При переходе в `Done` — тоже.

### 5. Поиск новых источников

Когда `NoPeers` и источников больше нет (момент перехода в `failed("stalled")`):

- поставить `Job::DiscoverAlbum { album_id }` с `PRIORITY_BACKGROUND`, если последний поиск альбома начинался
  больше 6 часов назад (`album_search_state.last_started_at`; новая функция
  `acquisition::searched_within(album_id, interval) -> bool`).
- `discover_album` сейчас выходит, если нет треков `adding`. Расширить условие `needs_search`:
  искать также, когда у альбома есть закрепление в `failed` с ошибкой `stalled`/`dead`
  (`pins::album_needs_sources(album_id) -> bool`). Остальной код менять не нужно: `verify_torrent` сопоставляет
  новые раздачи со всеми треками, кроме `ready`, и добавляет им запасные `track_sources`; `finalize` для альбома
  без `adding` ничего не меняет.
- Очередной повтор закрепления начнёт с primary, затем по `handle_stall` дойдёт до новых источников.
  Чтобы не ждать: после `verify_torrent`, добавившего источник треку с закреплением `failed("stalled"|"dead")`,
  вернуть закрепление в очередь (`pins::requeue_stalled_for_tracks(&track_ids)` в той же транзакции, что
  `insert_many`) и разбудить менеджер событием (менеджер уже просыпается по `TrackStatus::Found`; добавить
  пробуждение по `Event::AcquisitionChanged` либо публиковать его здесь).

### 6. Уборка

В начале `tick` удалять из `stalls` и `tried` ключи, которых нет среди открытых закреплений.

## Тесты (обязательные)

`api/tests/download_manager.rs` (фейковый `FileProvider`, малые интервалы в `ManagerConfig`):

- `db_error_on_start_does_not_fail_pin` / `transient_failure_retries_forever`: `ensure_files` 10 раз подряд отдаёт
  `Storage` → закрепление каждый раз возвращается в очередь, `retries == 0`, после успеха — `downloading`.
- `metadata_timeout_switches_source`: `ensure_files` первого источника — `MetadataTimeout`, есть второй источник →
  primary переключён, закрепление `queued`, не `failed`.
- `stalled_schedule_then_dead`: единственный источник зависает → `failed("stalled")` с растущим `next_retry_at`;
  после 6 циклов `error == "dead"`, `next_retry_at IS NULL`, дальнейшие тики его не трогают.
- `progress_resets_retries`.
- `stalled_pin_requests_new_sources`: при переходе в `failed("stalled")` в очереди появляется `discover_album`;
  повторно в течение 6 часов — не появляется.
- `new_source_revives_dead_pin`: закрепление `dead`, `verify_torrent` добавил источник → закрепление `queued`.
- `permanent_failure_is_not_retried`: `InvalidFileIndex` → `failed`, `next_retry_at IS NULL`.

`worker/tests/discover.rs`: `discover_album_searches_for_stalled_pin` (треки `found`, закрепление `failed("stalled")`
→ провайдеры опрошены, новая раздача привязана).

`db/tests/repos.rs`: `pins::fail`, `retry_failed`, `reset_retries`, обнуление в `requeue`/`pin_tracks`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные; `just docs-check` зелёный.
- `docs/operations.md` (раздел о загрузках) описывает новую модель повторов; в `docs/api.md`/OpenAPI значения
  `error` закрепления дополнены `dead` (если поле там перечислено).
- Контракт API не меняется (новых полей нет).

## Не входит

- Показ `next_retry_at` в интерфейсе.
- Изменение `stall_timeout` и логики паузы.
