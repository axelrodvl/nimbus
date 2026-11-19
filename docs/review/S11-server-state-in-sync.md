# S11 — Серверный статус альбома не синхронизируется: каждое открытие альбома — запрос и мигание

**Приоритет:** P1 · **Область:** `backend/migrations`, `backend/crates/db/src/repo/sync.rs`, `client/src/lib/sync`,
`client/src/lib/store`, `client/src/components/downloads/server-download-button.tsx`, `client/src/lib/acquisition` ·
**Зависит от:** —

## Проблема

Библиотека целиком лежит на клиенте (снимок + дельты по `sync_txid`, IndexedDB, Zustand-store), и экраны альбома и
артиста рендерятся из store синхронно. Исключение — **серверный статус альбома** (скачан / закреплён / качается):
`ServerDownloadButton` берёт его из `useAlbumAcquisition` → `GET /api/acquisition?album_ids=N` при **каждом**
открытии альбома. До `91413f4` кнопка мигала на каждом открытии; `91413f4` добавил спиннер на время запроса и кэш
последних ответов в `localStorage` (`nimbus.acquisition.albums`). Это лечит симптом и вносит свои ошибки:

1. **Вытеснение выбирает не те записи.** `saveAlbumItem` делает `Object.entries(...).slice(-200)` в расчёте на
   порядок вставки, но ключи — числовые строки (`"123"`), и JS перечисляет их **по возрастанию числа**. Остаются
   200 альбомов с наибольшими id; альбом с маленьким id вытесняется сразу после записи и мигает всегда.
2. **Кэш расходится с TanStack.** Оптимистичные изменения и live-прогресс (`updateAlbumRow` в `cache.ts`) в
   `localStorage` не пишутся; `acquisition.changed` перезапрашивает только активные запросы. Закрепил альбом → ушёл →
   кэш TanStack выгружен (5 мин) → вернулся: на миг старая «Скачать на сервер», потом «На сервере».
3. **Спиннер — тоже скачок вёрстки** (`w-36` → кнопка другой ширины) при первом открытии каждого альбома;
   `initialDataUpdatedAt: 0` — запрос на каждое открытие, при беспорядочных кликах — на каждый клик.
4. **Второй источник истины** рядом с IndexedDB; синхронный `JSON.parse`/`stringify` всего хранилища в главном
   потоке на каждое открытие и каждый ответ.
5. Кнопка исчезает при `!online` (в том числе на время переподключения сокета) — шапка альбома прыгает.

При этом почти всё нужное для статуса **уже синхронизируется**: состояние альбома (`state_cte!` в
`backend/crates/db/src/repo/acquisition.rs`) вычисляется из статусов треков, а `tracks.status` (включая `ready` —
«файл целиком в кэше сервера») есть в `SyncTrack`:

| Состояние | Из чего | На клиенте |
|---|---|---|
| `searching` | есть трек `adding` | есть |
| `partial` / `missing` | `not_found` с `found`/`ready` / без | есть |
| `downloaded` | все треки `ready` | есть |
| `available` | всё `found`/`ready`, не всё `ready` | есть |
| `downloading` | активная загрузка файла primary-источника (`downloads` без `completed_at`) | только live `download.progress` |
| закрепление (`pinned`, `queued`/`downloading`/`failed`/`waiting_source`/`done`, `error`) | `pinned_tracks` | **нет** |

## Текущее состояние (прочитай перед началом)

- `backend/migrations/0012_sync.sql` — штампы `sync_txid`, `sync_touch_tracks*` (образец: триггеры на
  `track_sources`/`track_plays`), надгробия.
- `backend/migrations/0011_pins.sql`, `backend/crates/db/src/repo/pins.rs` — `pinned_tracks` и все места, где меняется
  `state`/`error` (и где меняются только служебные `retries`/`next_retry_at`/`updated_at`).
- `backend/crates/db/src/repo/sync.rs` — `TRACK_SELECT`, структура `SyncTrack`; `backend/crates/api/src/sync.rs`.
- `backend/crates/db/src/repo/acquisition.rs` — `state_cte!` (эталон приоритетов состояния).
- `client/src/lib/sync/engine.ts` (`SYNC_SCHEMA`), `client/src/lib/db/types.ts`, `client/src/lib/store/library.ts`
  (`patchTracks`), `client/src/lib/store/selectors.ts`, `client/src/lib/store/hooks.ts`, `client/src/lib/store/live.ts`
  (`downloadProgress`).
- `client/src/components/downloads/server-download-button.tsx`, `client/src/lib/acquisition/{hooks,cache,actions}.ts`
  (`useAlbumAcquisition`, `updateAlbumRow`, `pinAlbum`/`unpinAlbum`), `client/src/screens/downloads/downloads.test.tsx`.
- `docs/review/S10-catalog-rows-sync-growth.md` и `docs/backlog.md` C14: в синхронизации есть и каталожные строки
  (`in_library = false`) — статус альбома считается **только по трекам `in_library`**, как в `state_cte!`.

## Что сделать

1. **Бэкенд: закрепление в `SyncTrack`.** Поля `pin: PinState | null` и `pin_error: string | null` (из
   `pinned_tracks` через `LEFT JOIN` в `TRACK_SELECT` и в дельте). Миграция (следующий свободный номер): триггеры
   уровня оператора на `pinned_tracks` (INSERT/DELETE — всегда; UPDATE — только для строк, где изменились `state` или
   `error`: в Postgres у триггера с transition tables нельзя указать список колонок, поэтому фильтр — внутри функции
   по `old_rows JOIN new_rows`), вызывающие `sync_touch_tracks`. Изменения `retries`/`next_retry_at`/`updated_at` не
   должны давать дельту. Обновить OpenAPI, `docs/api.md`.
2. **`SYNC_SCHEMA` → 2** на бэкенде и клиенте: клиенты один раз берут свежий снимок (так устроен `start()`).
3. **Клиент: селектор `albumServerState(albumId)`** в `store/selectors.ts` (с хуком в `store/hooks.ts`), повторяющий
   `state_cte!`: те же счётчики по трекам `in_library`, тот же приоритет; `downloading` — есть трек с
   `pin = 'downloading'` **или** есть запись `downloadProgress` в LiveStore; агрегат закрепления — тот же порядок
   `downloading > queued > failed > waiting_source > done`; байты/скорость — из LiveStore. Мемоизация по ссылкам
   на строки треков альбома (не проход по всей библиотеке — см. F03).
4. **`ServerDownloadButton` читает только store.** Ни запроса, ни спиннера, ни `localStorage`: статус известен в
   первом кадре. `pinAlbum`/`unpinAlbum` — оптимистичный патч треков альбома в store (`pin`), откат при ошибке;
   дельта затем подтверждает. Офлайн / сервер недоступен — кнопка остаётся на месте неактивной (не исчезает).
5. **Удалить** `useAlbumAcquisition`, `nimbus.acquisition.albums` (и очистку старого ключа при старте — одна строка),
   `albumKey`/`ALBUM_ROOT`-ветку в `updateAlbumRow`/`snapshotRows`, если больше никем не используются. Экран
   «Загрузки» (списки, сводка, статистика поиска, ошибки провайдеров) остаётся на REST — это служебный экран.
6. Обновить `docs/architecture.md` (что синхронизируется) и раздел про кнопку в документации клиента, если он есть.

## Тесты (обязательные)

- Бэкенд (`backend/crates/db/tests/sync.rs`): `pin_album_bumps_tracks_in_delta`, `pin_state_change_bumps_track`,
  `pin_retries_only_update_no_delta` (изменение только `retries`/`next_retry_at` — дельта пуста),
  `unpin_bumps_track_with_null_pin`, снимок содержит `pin`/`pin_error`.
- Паритет: `album_server_state_matches_backend` — набор фикстур (все комбинации статусов треков, каталожные треки
  `in_library = false`, закрепления во всех состояниях) прогоняется через `state_cte!` (тест бэкенда, сохраняет
  ожидаемые значения в JSON-фикстуру в репозитории) и через клиентский селектор (тест клиента читает ту же фикстуру).
- Клиент (`downloads.test.tsx`/селекторы): кнопка рендерится в первом кадре **без** сетевого запроса
  (`listAcquisition` не вызывается); `server-download-loading` больше не существует; оптимистичное закрепление и
  откат при ошибке; live `download.progress` переводит в «качается» без дельты; офлайн — кнопка на месте, неактивна.
- Синхронизация: старый клиентский формат (`schema = 1` в `meta`) → снимок.

## Критерии приёмки

- `just check`, `just test`, `just docs-check`, `just client-perf` зелёные.
- Открытие любого альбома библиотеки не делает ни одного запроса к `/api/acquisition` (проверено тестом).
- В Журнале — что удалено и как проверен паритет состояний.
