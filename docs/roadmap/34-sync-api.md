# Шаг 34 — API синхронизации: снимок, дельта, сессия

**Фаза 1 · Зависит от:** 25 · **Закрывает находки:** S4, S5

## Зачем

Новый клиент (фаза 2) держит всю библиотеку у себя и не ходит на сервер при навигации. Для этого ему
нужны две операции: «дай всё» (снимок) и «дай то, что изменилось с курсора X» (дельта), причём дельта
**не имеет права терять изменения** даже при параллельных транзакциях воркеров. Плюс лёгкий сигнал по
WebSocket «есть изменения» и эндпоинт, по которому SPA понимает, нужен ли вход.

## Текущее состояние (прочитай перед началом)

- `backend/migrations/0002_schema.sql`, `0006_playlists.sql` — таблицы `artists`, `albums`, `tracks`, `track_sources`, `track_plays`, `playlists`, `playlist_tracks`.
- `backend/crates/db/src/repo/views.rs` — `ArtistView`, `AlbumView`, `TrackView`; обрати внимание, как вычисляются `needs_confirmation` и `transcode` (режим воспроизведения) у трека.
- `backend/crates/api/src/library.rs` — DTO и постраничные списки (остаются для старого `web/`).
- `backend/crates/api/src/auth.rs` — `require_token`, `is_public`, cookie `nimbus_token`.
- `backend/crates/core/src/events.rs` — `enum Event`; `backend/crates/api/src/ws.rs` — трансляция событий.
- `backend/crates/db/src/settings.rs` — таблица `settings` (ключ → JSON).

## Модель согласованности (контракт)

- У каждой синхронизируемой строки есть `sync_txid BIGINT` — номер транзакции (`txid_current()`), которая последней её записала. Ставит триггер, код приложения о нём не знает.
- Ответ снимка/дельты формируется в одной транзакции `REPEATABLE READ READ ONLY`. Курсор ответа — `txid_snapshot_xmin(txid_current_snapshot())` этой транзакции, то есть номер самой старой ещё не завершённой транзакции.
- Дельта от курсора `C` — все строки с `sync_txid >= C`. Транзакция, не видимая предыдущему ответу, имела номер `>= C`, значит попадёт в следующий. Дельта может прислать уже известные строки (клиент делает upsert — это безопасно), но **никогда не пропускает** изменения.
- Удаления — таблица надгробий `sync_tombstones`, заполняется триггерами `AFTER DELETE`.
- Курсор для клиента — непрозрачная строка `"<schema>.<epoch>.<xmin>"`. `schema` — версия формата (константа `SYNC_SCHEMA = 1`), `epoch` — случайный идентификатор базы (создаётся миграцией). Несовпадение `schema`/`epoch` или слишком старый `xmin` → сервер отвечает `reset: true`, клиент заново берёт снимок.
- **Уточнение при реализации.** Постраничная выдача (п. 5) продолжается курсором `<schema>.<epoch>.<xmin>.<txid>.<rank>.<id>`: «`cursor` = `sync_txid` последней строки» не продвигался бы, когда >5000 строк записала одна транзакция (массовый импорт). `xmin` в таком курсоре — снимок первой страницы серии, он же итоговый курсор. Для клиента курсор по-прежнему непрозрачная строка. Режим `playback` трека не зависит от `settings.playback` (проверено в `views.rs`: только CUE и расширение primary-файла), поэтому п. 8 не потребовал кода.

## Что сделать

1. **Миграция** (следующий свободный номер, фактически `0012_sync.sql` (`0011` занят закреплениями шага 33)):
   - `ALTER TABLE … ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0` для `artists`, `albums`, `tracks`, `playlists`, `playlist_tracks`; индекс по `sync_txid` на каждой;
   - функция-триггер `sync_stamp()` (`BEFORE INSERT OR UPDATE … FOR EACH ROW`: `NEW.sync_txid := txid_current()`) на этих пяти таблицах;
   - `CREATE TABLE sync_tombstones (entity TEXT NOT NULL, entity_id BIGINT NOT NULL, sync_txid BIGINT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (entity, entity_id))` + индекс по `sync_txid`; триггеры `AFTER DELETE` (`entity` = `artist|album|track|playlist|playlist_track`, `ON CONFLICT … DO UPDATE`);
   - **производные поля трека.** `needs_confirmation`, режим воспроизведения и счётчик прослушиваний живут в `track_sources` и `track_plays`. Триггеры уровня оператора (`AFTER INSERT OR UPDATE OR DELETE … REFERENCING … FOR EACH STATEMENT`, по одному на вид операции — Postgres не разрешает transition tables для нескольких событий сразу) на `track_sources` и `track_plays` «касаются» затронутых треков: `UPDATE tracks SET sync_txid = txid_current() WHERE id IN (SELECT DISTINCT track_id FROM <transition table>)`;
   - сигнал: в `sync_stamp()` и триггерах удаления — `PERFORM pg_notify('nimbus_sync', '')` (одинаковые уведомления в одной транзакции Postgres склеивает сам);
   - `INSERT INTO settings (key, value) VALUES ('sync', jsonb_build_object('epoch', gen_random_uuid()::text, 'floor', 0))` (сверь имена колонок с `0004_settings.sql`).
2. **Репозиторий `db::repo::sync`:**
   - `begin_snapshot(pool) -> (Transaction, xmin: i64)` — открывает `REPEATABLE READ READ ONLY`, читает xmin;
   - потоковые выборки (`fetch`, не `fetch_all`) всех строк каждой сущности и выборки `WHERE sync_txid >= $1`;
   - `tombstones_since(tx, cursor)`; `purge_tombstones(pool, older_than: Duration)` — удаляет надгробия старше 30 дней и записывает в `settings.sync.floor` максимальный удалённый `sync_txid + 1`;
   - `meta(pool) -> { epoch, floor }`.
3. **DTO** (`crates/api/src/sync.rs`, все в OpenAPI). Строки нормализованы — без склеенных имён и счётчиков, клиент вычисляет их сам:
   ```
   SyncArtist   { id, mbid, name, sort_name, disambiguation, in_library, added_at }
   SyncAlbum    { id, mbid, artist_id, title, year, primary_type, secondary_types, cover_url, in_library, added_at }
   SyncTrack    { id, mbid_recording, album_id, artist_id, title, disc_no, position, duration_ms,
                  status, status_reason, in_library, added_at, needs_confirmation, playback,
                  play_count, last_played_at }
   SyncPlaylist { id, name, created_at, last_used_at }
   SyncPlaylistTrack { id, playlist_id, track_id, added_at }
   ```
   `playback` и `needs_confirmation` вычисляются тем же SQL-выражением, что в `TrackView` — вынеси его в общий фрагмент, не копируй.
   Синхронизируются **все** строки этих таблиц (и не в библиотеке тоже: страница артиста показывает всю дискографию).
4. **`GET /api/sync/snapshot`** — поток `application/x-ndjson`, по одному JSON-объекту в строке:
   - первая строка `{"type":"begin","cursor":"…","schema":1}`;
   - далее `{"type":"artist","row":{…}}`, `album`, `track`, `playlist`, `playlist_track` — именно в этом порядке сущностей;
   - последняя `{"type":"end","counts":{"artists":N,"albums":N,"tracks":N,"playlists":N,"playlist_tracks":N}}`. Клиент считает снимок принятым, только получив `end`.
   Реализация: задача (`tokio::spawn`, отслеживаемая) владеет транзакцией и пишет строки в `mpsc::channel(256)`; тело ответа — `Body::from_stream(ReceiverStream)`. Если получатель ушёл (клиент закрыл соединение) — задача завершает транзакцию и выходит. Ошибка БД посреди потока → поток обрывается **без** строки `end`.
5. **`GET /api/sync/changes?cursor=…`** → JSON
   ```
   { cursor, reset: bool,
     artists: [SyncArtist], albums: [SyncAlbum], tracks: [SyncTrack],
     playlists: [SyncPlaylist], playlist_tracks: [SyncPlaylistTrack],
     deleted: [{ entity, id }], more: bool }
   ```
   - `reset: true` (остальные поля пустые), если курсор не разбирается, не совпал `schema`/`epoch` или `xmin < floor`;
   - ограничение размера: не более 5000 строк суммарно. Если изменённых строк больше — отдать первые 5000 по возрастанию `(sync_txid, entity, id)`, `more: true`, а `cursor` = `sync_txid` последней отданной строки (клиент сразу запросит ещё; повтор строк с тем же txid допустим). Когда всё влезло — `more: false`, `cursor` = xmin снимка;
   - надгробие не отдаётся, если строка с таким id существует (в одном ответе живая строка и её надгробие не встречаются — клиент на это полагается);
   - без параметра `cursor` → 400 `invalid_cursor`.
6. **Сжатие.** Для маршрутов `/api/sync/*` включить `tower_http::compression::CompressionLayer` (gzip, br). Не включай его глобально: аудиостримы сжимать нельзя.
7. **Событие `sync.poke {}`.** Вариант `Event::SyncPoke` (`#[serde(rename = "sync.poke")]`). Фоновая задача под супервизором (как watcher в шаге 31; до шага 31 — простой цикл с перезапуском) держит `PgListener` на канале `nimbus_sync`, склеивает уведомления (не чаще одного события в 300 мс, первое — сразу) и публикует `SyncPoke` в `EventBus`. При разрыве `LISTEN`-соединения — переподключение и один `SyncPoke` (могли пропустить уведомления).
8. **Изменение настроек воспроизведения.** Если режим `playback` трека зависит от `settings.playback` (проверь в `views.rs`), то `PUT /api/settings`, меняющий эти поля, одним запросом касается всех треков с primary-источником (`UPDATE tracks SET sync_txid = txid_current() WHERE id IN (SELECT track_id FROM track_sources WHERE is_primary)`).
9. **`GET /api/auth/session`** — публичный (`is_public`): `{ auth_required: bool, authenticated: bool }`. `authenticated = true`, если авторизация выключена или предъявлен верный токен (cookie/Bearer).
10. **Обслуживание.** `maintenance_loop` раз в сутки вызывает `purge_tombstones(30 дней)`.
11. **Контракты и документация:** `just openapi && just web-gen-api`; `docs/api.md` (раздел «Синхронизация» с описанием модели согласованности), `docs/architecture.md`.

## Тесты (обязательные)

`crates/db/tests/sync.rs` (`#[sqlx::test]`):
- вставка/обновление каждой из пяти сущностей меняет `sync_txid`; удаление создаёт надгробие; повторное создание и удаление строки с тем же id не падает;
- изменение `track_sources` (вставка, смена primary, удаление) и `track_plays` касается нужных треков и только их;
- **гонка, ради которой всё затевалось:** транзакция A открыта и изменила трек, но не закоммичена → взять дельту (курсор `C1`) → закоммитить A → дельта от `C1` содержит изменение A;
- `purge_tombstones` удаляет только старые и поднимает `floor`.

`crates/api/tests/sync.rs`:
- снимок: порядок строк `begin → … → end`, `counts` совпадают с числом строк, каждая строка — валидный JSON; пустая библиотека → только `begin` и `end`;
- дельта: после снимка без изменений — пусто и `more: false`; после изменения альбома — только он; удаление → `deleted`; каскадное удаление артиста даёт надгробия альбомов и треков;
- постраничность: 12 000 изменённых треков → три запроса с `more: true/true/false`, объединение покрывает все id без пропусков;
- `reset`: мусорный курсор, чужой `epoch`, другая `schema`, `xmin` ниже `floor`;
- сжатие: `Accept-Encoding: gzip` → `Content-Encoding: gzip` на `/api/sync/changes`, и его **нет** на `/api/tracks/{id}/stream`;
- `sync.poke`: изменение трека → событие в шине в пределах 2 с (хелпер `eventually`); 100 изменений подряд → не более 3 событий;
- изменение `settings.playback` → затронутые треки приходят в дельте с новым `playback`;
- `GET /api/auth/session`: без токена при включённой авторизации → `{true,false}`; с cookie → `{true,true}`; авторизация выключена → `{false,true}`; сам эндпоинт не требует токена; `/api/sync/*` без токена → 401;
- клиент закрыл соединение посреди снимка → задача-источник завершилась (счётчик активных задач вернулся к нулю).

## Критерии приёмки

```
just db-up && just check && just test && just cov
just openapi && just web-gen-api && just web-check
```

Записать в Журнал: время и размер (сжатый/несжатый) снимка на синтетической библиотеке 5 000 альбомов / 60 000 треков
(тест с `#[ignore]` + `--nocapture` или отдельный бенч — на выбор, главное цифра).

## Не входит в шаг

- Клиентская часть (шаг 37).
- Синхронизация настроек, источников, загрузок, состояния приобретения — они запрашиваются обычными эндпоинтами по требованию.
- Офлайн-мутации и разрешение конфликтов: мутации идут обычными эндпоинтами и требуют сети.

## Подводные камни

- `txid_current()` возвращает 64-битный номер с эпохой — переполнения нет. Не используй тип `xid` (32 бита).
- Долгая чужая транзакция (например, `pg_dump`) удерживает xmin: дельты будут повторно присылать одни и те же строки, пока она открыта. Это корректно; клиентский upsert идемпотентен.
- Триггер `sync_stamp` срабатывает и на `UPDATE`, который ничего не меняет, — не добавляй условие `IS DISTINCT FROM`: «касание» из п. 1 как раз на это рассчитывает.
- Триггеры на `track_sources` срабатывают при массовых вставках verify (шаг 29) — именно поэтому они уровня оператора, а не строки.
- Каскадные удаления (`ON DELETE CASCADE`) вызывают `AFTER DELETE`-триггеры дочерних таблиц — проверь тестом, не полагайся.
- Старый `web/` продолжает работать: существующие эндпоинты и DTO не трогаем.
