# Шаг 37 — Локальные данные: IndexedDB, store, движок синхронизации

**Фаза 2 · Зависит от:** 34, 36 · **Закрывает находку:** F1 (ядро)

## Зачем

Сердце нового клиента. Вся библиотека лежит в IndexedDB и в памяти; экраны читают только из памяти,
поэтому навигация не зависит от сети. Движок синхронизации один раз берёт снимок, затем подтягивает
дельты по сигналу. Шаг делает только логику (`src/lib/**`) — без экранов; проверяется unit-тестами.

## Текущее состояние

- Серверный контракт — `docs/roadmap/34-sync-api.md` (разделы «Модель согласованности», пп. 3–5, 7). Типы — в `client/src/lib/api/schema.d.ts` (`SyncArtist`, `SyncAlbum`, `SyncTrack`, `SyncPlaylist`, `SyncPlaylistTrack`).
- `client/src/lib/api/client.ts` — клиент API (шаг 36).
- Старый подход для сравнения: `web/providers/live-library-provider.tsx` (события → `router.refresh()`), `web/lib/data/library.ts`.
- Форматы событий WebSocket: `web/lib/api/events.ts` и `backend/crates/core/src/events.rs`.

## Что сделать

Все модули — чистый TypeScript без React, зависимости передаются параметрами (API-клиент, база, часы) — так они тестируются.

1. **`src/lib/db/` — IndexedDB (`idb`).** База `nimbus`, версия 1:
   | Хранилище | Ключ | Индексы |
   |---|---|---|
   | `artists`, `albums`, `tracks`, `playlists`, `playlist_tracks` | `id` | — |
   | `meta` | строковый ключ | — (`cursor`, `schema`, `syncedAt`) |
   | `outbox` | автоинкремент | — (отложенные запросы, п. 7) |
   Функции: `openDb()`, `loadAll() -> { artists, albums, tracks, playlists, playlistTracks, meta }` (параллельные `getAll`),
   `applyBatch(batch)` (upsert + удаления + новый курсор **в одной транзакции**), `replaceAll(snapshotWriter)` (очистка и заливка снимка),
   `clear()`. Обработчик `onversionchange`/`blocked` — закрыть соединение и сообщить наверх (другая вкладка обновила схему).
   Если IndexedDB недоступна (приватный режим, отказ) — работать только в памяти и выставить флаг `persistent: false`.
2. **`src/lib/store/library.ts` — store в памяти (zustand vanilla, `createStore`).** Состояние:
   - `artists`, `albums`, `tracks`, `playlists`: `Map<number, …>`; `playlistTracks: Map<number, SyncPlaylistTrack>`;
   - индексы: `albumsByArtist`, `tracksByAlbum`, `tracksByPlaylist` (`Map<number, number[]>`), поддерживаются **инкрементально** в `applyBatch`;
   - `version: number` (растёт на каждое применение) и `hydrated: boolean`.
   Действия: `hydrate(data)`, `applyBatch(batch)`, `replaceAll(data)`, `patchTrack(id, partial)` (для мгновенных событий), `reset()`.
   Каждое действие — одно обновление состояния (один рендер), `Map` копируются поверхностно только те, что изменились.
3. **`src/lib/store/selectors.ts` — производные данные** (то, что раньше считал сервер; мемоизация по `version` или по входным ссылкам):
   - `albumView(id)` → альбом + `artistName` + `trackCount` + `statusCounts { adding, found, not_found, ready }` (по трекам с `in_library`, как в `AlbumDto` — сверь с `views.rs`);
   - `trackView(id)` → трек + `albumTitle`, `artistName`, `coverUrl`;
   - `artistView(id)` → артист + `albumCount`, `trackCount`;
   - списки: `libraryArtists()`, `libraryAlbums()`, `libraryTracks(statusFilter)` — те же фильтры и сортировки, что у эндпоинтов `/api/library/*` (прочитай SQL в `views.rs` и повтори порядок);
   - `artistAlbums(artistId)`, `albumTracks(albumId)` (по `disc_no`, `position`), `playlistTracks(playlistId)`;
   - `recentlyPlayedAlbums(limit)` (по `last_played_at` треков), `favorites()` (топ-100 по `play_count`, затем `last_played_at` — как динамический плейлист на сервере, см. `0006_playlists.sql` и `playlists.rs`);
   - `searchLocal(query, limit)` — поиск по подстроке без учёта регистра и диакритики по артистам/альбомам/трекам библиотеки.
   React-хуки поверх (`useAlbumView(id)` и т. п.) — в `src/lib/store/hooks.ts`, через `useStore` с селектором и поверхностным сравнением.
4. **`src/lib/sync/engine.ts` — движок.** Состояния: `idle | hydrating | snapshot | delta | live | error | offline`; отдельный маленький store `syncStatus`
   (`state`, `lastSyncedAt`, `error`, `progress { received, total? }`).
   - **Старт:** `loadAll()` → `hydrate` (экраны уже могут рисовать) → если курсора нет — снимок, иначе дельта.
   - **Снимок:** `GET /api/sync/snapshot`, потоковое чтение (`response.body.getReader()` + `TextDecoder`, разбор по строкам, строка может прийти разорванной между чанками).
     Строки копятся и пишутся в IndexedDB пачками по 2000. Снимок принят **только** при получении `end` с совпавшими `counts`; иначе всё отбрасывается и повторяется.
     Пока снимок не принят, старые данные остаются на экране; после — `replaceAll` одним действием.
   - **Дельта:** `GET /api/sync/changes?cursor=`; `applyBatch` в IndexedDB, затем в store; пока `more: true` — повторять сразу; `reset: true` → снимок.
   - **Одиночный полёт:** одновременно выполняется одна синхронизация; запрос во время выполнения ставит флаг «повторить после».
   - **Триггеры дельты:** событие `sync.poke`, событие `resync`, (пере)подключение WebSocket, `online`, возврат вкладки на передний план (`visibilitychange`), страховочный таймер раз в 5 минут.
   - **Ошибки:** сеть/5xx → экспоненциальная пауза 1 с → 30 с с джиттером, состояние `error`/`offline`; 401 → остановиться и вызвать `onUnauthorized`.
   - API: `start()`, `stop()`, `requestSync(reason)`, `resetAndResync()`.
5. **Мгновенные события.** `track.status` → `patchTrack` (и запись в IndexedDB) сразу, не дожидаясь дельты; `job.progress` и `stream.progress` — в отдельный
   эфемерный store `src/lib/store/live.ts` (`albumProgress`, `streamProgress`; логику очистки возьми из `live-library-provider.tsx`). Не сохраняются.
6. **Несколько вкладок.** Синхронизирует одна вкладка — лидер (`navigator.locks.request('nimbus-sync', …)`; если Web Locks нет — каждая вкладка сама себе лидер).
   Лидер рассылает применённые пачки через `BroadcastChannel('nimbus-sync')`; остальные вкладки применяют их только к своему store (в IndexedDB уже записано).
   Закрылся лидер — блокировку получает следующая вкладка и делает дельту.
7. **Оптимистичные мутации — `src/lib/store/mutations.ts`.** Хелпер `mutate({ apply, request, rollback })`: применить к store → выполнить запрос →
   при ошибке откатить и вернуть `ApiError` (toast показывает вызывающий код). После успеха — `requestSync('mutation')`.
   **Outbox** — только для `POST /api/tracks/{id}/played`: если сети нет, запись кладётся в `outbox` и отправляется при появлении сети (порядок сохраняется, 4xx — выбросить, сеть/5xx — оставить).
   Остальные мутации без сети завершаются ошибкой `offline`.
8. **Сборка воедино — `src/lib/app-data.ts`:** создаёт db, store, движок; экспортирует синглтоны и `bootstrap()`; в тестах всё создаётся заново через фабрики.
   В `main.tsx` пока не подключать (это сделает шаг 38) — или подключить за флагом, если так проще проверить вручную.
9. **Фабрики для тестов** в `src/test/factories.ts`: `makeArtist/Album/Track/Playlist`, `makeLibrary({ artists, albumsPerArtist, tracksPerAlbum })`,
   фейковый сервер синхронизации `FakeSyncServer` (хранит строки с txid, отдаёт снимок/дельту по контракту шага 34, умеет обрывать поток, отвечать `reset`, `more`).

## Тесты (обязательные; Vitest, `fake-indexeddb`, fake timers)

- **db:** `applyBatch` атомарен (ошибка посередине — ни строки, ни курсор не изменились); `loadAll` возвращает записанное; недоступная IndexedDB → режим в памяти;
- **store:** индексы верны после вставки, **перемещения** (трек сменил `album_id`), удаления, каскада (удалён альбом — его треки пришли в `deleted`); `version` растёт; одно применение — одно уведомление подписчиков;
- **селекторы:** `statusCounts`, сортировки списков, `favorites`, `recentlyPlayedAlbums`, `searchLocal` (регистр, диакритика, «ё/е»); мемоизация — тот же результат по ссылке при неизменных данных;
- **движок:** первый запуск → снимок → `live`; повторный запуск с курсором → дельта без снимка; `more: true` дочитывается; `reset` → снимок;
  оборванный снимок (нет `end`) не портит имеющиеся данные и повторяется; строка NDJSON, разорванная между чанками, собирается; одиночный полёт (5 `requestSync` подряд → не более 2 запросов);
  пауза и повтор при 503; 401 → `onUnauthorized` и остановка; `sync.poke` и `visibilitychange` запускают дельту;
- **идемпотентность:** применить одну и ту же дельту дважды → состояние не меняется;
- **мутации:** успех; откат при ошибке; outbox переживает «перезапуск» (новый экземпляр на той же базе) и отправляется по порядку;
- **вкладки:** два экземпляра на общих `fake-indexeddb` и `BroadcastChannel` — синхронизирует один, данные видны в обоих;
- **производительность (тест с порогом):** `hydrate` 60 000 треков < 500 мс; `applyBatch` на 100 строк при 60 000 в store < 10 мс; `libraryTracks()` повторно (без изменений) < 1 мс.

## Критерии приёмки

```
just client-check && just client-test && just client-cov     # src/lib/** ≥ 90 %
```

В Журнал: цифры из тестов производительности.

## Не входит в шаг

- React-экраны и оболочка (шаги 38–39), WebSocket-соединение (шаг 38 передаёт события в движок через `engine.handleEvent(e)`).
- Офлайн-мутации (кроме счётчика прослушиваний), разрешение конфликтов.
- Данные вне библиотеки: поиск, источники, настройки, загрузки — это TanStack Query в своих шагах.

## Подводные камни

- `Map` в zustand: меняй ссылку (`new Map(old)`) только у изменившихся коллекций, иначе селекторы не заметят изменений либо будут пересчитываться зря.
- Селектор, возвращающий новый массив на каждый вызов, вызывает бесконечные перерисовки в `useSyncExternalStore` — возвращай мемоизированные ссылки.
- `fake-indexeddb` медленнее настоящей — пороги производительности из тестов относятся к store, а не к базе.
- Дельта может вернуть строки, которые уже есть, и строку, а позже её надгробие (и наоборот — надгробие старого id и новую строку). Применяй сначала upsert, затем удаления **только если** это не противоречит порядку: сервер гарантирует, что живая строка и её надгробие в одном ответе не встречаются (шаг 34, первичный ключ надгробий) — закрепи тестом на фейковом сервере.
- Числовые id приходят как JSON-числа (`i64`); значения в пределах 2^53 — отдельная обработка не нужна.
