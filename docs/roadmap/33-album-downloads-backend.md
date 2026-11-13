# Шаг 33 — Скачивание альбомов на сервер: закрепление, очередь, пауза

**Фаза 1 · Зависит от:** 31, 32 · **Закрывает находку:** D7

## Зачем

Сейчас файл попадает в кэш сервера только когда его слушают, и может быть вытеснен в любой момент.
Нужна явная операция «скачать альбом/трек»: закрепить (pin), скачать как можно быстрее, не вытеснять,
показать прогресс, уметь приостановить и отменить. Это вторая серверная половина экрана «Загрузки».

## Текущее состояние

- `backend/crates/torrent/src/lib.rs` — `ensure_files(TorrentRef, &[usize])` (шаги 27–28), `file_progress`, `pause_torrent`/`resume_torrent`, `release_file`.
- `backend/crates/api/src/stream.rs` — `register_download` (создаёт строку `downloads`), `Watcher` (переводит треки в `ready`, шлёт `stream.progress`).
- `backend/crates/db/src/repo/downloads.rs` — таблица `downloads (torrent_id, file_index, local_path, bytes_total, bytes_done, completed_at, last_played_at)`.
- `backend/crates/worker/src/cache.rs` — `evict_cache`: вытесняет по `last_played_at`, пропускает `activity.is_protected`.
- `backend/crates/api/src/downloads.rs` — `GET /api/downloads` (торренты движка), пауза/возобновление одного торрента.
- `backend/crates/api/src/acquisition.rs`, `db::repo::acquisition` — состояние приобретения (шаг 32).
- `backend/crates/api/src/settings.rs` — `GET /api/storage`.

## Что сделать

1. **Миграция `0010_pins.sql`:**
   ```sql
   CREATE TABLE pinned_tracks (
       track_id     BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
       album_pin    BOOLEAN NOT NULL DEFAULT FALSE,   -- закреплён в составе альбома
       requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       state        TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','downloading','done','waiting_source','failed')),
       error        TEXT,
       updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX pinned_tracks_state_idx ON pinned_tracks (state, requested_at);
   ```
   `waiting_source` — трек ещё не `found` (поиск идёт или не найден): закрепление ждёт источника.
   Репозиторий `db::repo::pins`.
2. **Менеджер загрузок** — новый модуль `crates/api/src/download_manager.rs` (или крейт `nimbus-downloads`, если так чище по зависимостям;
   ему нужны БД, `FileProvider`, `EventBus`, настройки):
   - фоновая задача под супервизором и `CancellationToken` (как watcher в шаге 31), будится `Notify` при изменениях и тикает раз в 2 с;
   - на тике: взять `queued` закрепления, сгруппировать по торренту primary-источника; одновременно активны не более
     `performance.download_concurrency` **торрентов** (новое поле настроек, по умолчанию 4, `1..=32`); внутри торрента все нужные файлы выбираются сразу одним `ensure_files`;
   - для каждого файла создать строку `downloads` (как `register_download`), состояние закрепления → `downloading`;
   - завершение файла фиксирует существующий `Watcher` (трек → `ready`); менеджер переводит закрепление в `done`;
   - трек не `found`/`ready` → `waiting_source`; при событии `track.status → found` менеджер будится и берёт его в работу;
   - **зависание:** если у файла нет прогресса `stall_timeout` (10 мин; в тестах настраивается) — попытаться переключиться на следующий источник трека (та же логика выбора, что `failover` в `stream.rs` — вынеси в общую функцию); если источников нет — `failed` с `error = "stalled"`; авто-повтор `failed` раз в час (до 5 раз, затем остаётся `failed`);
   - CUE-образы и перекодируемые источники: закрепление скачивает исходный файл (образ) целиком — это корректно, трек станет `ready`.
3. **Глобальная пауза.** Состояние `downloads_paused: bool` в таблице `settings` (отдельный ключ `runtime`, не в `Settings`, чтобы не смешивать с конфигурацией) —
   переживает рестарт. На паузе менеджер не начинает новые загрузки и ставит на паузу торренты, качающиеся **только** ради закреплений (не трогает те, что сейчас стримятся — `activity`).
4. **Защита от вытеснения.** `evict_cache` не трогает файлы, являющиеся primary-источником закреплённого трека.
   Если закреплённое превышает лимит кэша — вытеснение останавливается с `warn`; `GET /api/storage` дополнить полями
   `pinned_bytes`, `pinned_files`, `over_limit: bool`.
5. **API** (в `crates/api/src/downloads.rs`; все — `authorize`, OpenAPI):
   - `POST /api/albums/{id}/download` — закрепить все треки альбома с `in_library` (`album_pin = true`) → `{ pinned: u32 }`; идемпотентно;
   - `DELETE /api/albums/{id}/download?delete_files=true|false` — снять закрепление; при `delete_files` — освободить файлы в движке и удалить с диска (если файл не нужен другому закреплённому треку и не стримится), треки `ready → found`;
   - `POST /api/tracks/{id}/download`, `DELETE /api/tracks/{id}/download?delete_files=`;
   - `POST /api/downloads/pause-all`, `POST /api/downloads/resume-all` → `{ paused: bool }`;
   - `GET /api/downloads` — дополнить ответ полями `paused`, `queue: { queued, downloading, waiting_source, failed }` (существующие поля не менять).
   - В `AcquisitionItem.download` (шаг 32) добавить: `pinned: bool`, `state` (агрегат закреплений альбома: `queued|downloading|done|waiting_source|failed`), `down_bps`, `peers`, `error`.
     `summary` — без изменений формы.
6. **Автозагрузка.** Настройка `storage.auto_download: "off" | "added"` (по умолчанию `off`). При `added` — каждый альбом/трек,
   добавляемый в библиотеку (`LibraryService::add_album`, `add_track`, импорт артиста), сразу закрепляется (`waiting_source` до нахождения).
7. **Событие `download.progress { album_id, bytes_done, bytes_total, down_bps, peers }`** — раз в секунду на альбом с активными закреплёнными загрузками
   (агрегат по файлам; издаёт менеджер). `acquisition.changed` — при смене агрегатного состояния закрепления.
8. **Старт процесса.** При запуске: закрепления `downloading` → `queued` (движок восстановит торренты из сессии; менеджер заново вызовет `ensure_files` — это идемпотентно).
9. **Документация:** `docs/api.md`, `docs/architecture.md` («Загрузки на сервер»), `README.md` (что такое закрепление и как оно соотносится с лимитом кэша).

## Тесты (обязательные)

Менеджер тестируется с фейковым `FileProvider` (управляемый прогресс) и настоящим Postgres; один сквозной тест — с локальным роем.

- закрепление альбома: все треки `queued` → `downloading` → (фейк завершил файлы, watcher-тик) → треки `ready`, закрепления `done`;
- лимит параллелизма: при `download_concurrency = 2` и 5 торрентах одновременно в `downloading` не больше 2 торрентов; файлы одного торрента идут одним `ensure_files`;
- `waiting_source`: закрепили альбом в `adding` → после `found` загрузка стартует сама;
- зависание: нет прогресса → переключение на следующий источник; без альтернатив → `failed("stalled")`; авто-повтор ограничен 5;
- пауза: `pause-all` → новые не стартуют, активные торренты на паузе, стримящийся файл не тронут; `resume-all` → продолжение; флаг переживает «рестарт» (новый менеджер на той же БД);
- рестарт посреди загрузки: `downloading → queued`, повторный `ensure_files`, прогресс не теряется (фейк хранит его);
- снятие закрепления без удаления: файлы остаются, вытеснение снова может их удалить; с удалением: файл удалён, трек `found`, общий файл (CUE-образ на несколько треков, один из которых ещё закреплён) **не** удаляется;
- вытеснение не трогает закреплённое; `over_limit` и `pinned_bytes` в `/api/storage`;
- `auto_download = added`: добавление альбома создаёт закрепления;
- API: идемпотентность `POST`, 404 для несуществующего, 401 без токена; `download` в `AcquisitionItem`; событие `download.progress` (агрегат по двум файлам).
- Сквозной (рой, `crates/api/tests/download_swarm.rs`): закрепить «альбом» из 3 файлов локального роя → все файлы на диске совпадают с исходными, треки `ready`.

## Критерии приёмки

```
just db-up && just check && just test && just cov
just openapi && just web-gen-api && just web-check
```

## Не входит в шаг

- Скачивание на устройство пользователя (шаги 46–47) — это другое хранилище.
- Интерфейс (шаг 44).

## Подводные камни

- Один файл может быть источником нескольких треков (CUE) и один трек может сменить primary-источник — закрепление привязано к **треку**; файл вычисляется в момент работы менеджера.
- Смена primary у закреплённого трека (`PUT /api/tracks/{id}/source`, failover) → закрепление возвращается в `queued`, старый файл освобождается существующей логикой `release_unneeded` (проверь, что она не удаляет файл, нужный другому закреплению).
- Не дублируй `Watcher`: переход `found → ready` остаётся за ним; менеджер только инициирует загрузки и следит за закреплениями.
- Пауза торрента в librqbit останавливает и раздачу — это ожидаемо.
