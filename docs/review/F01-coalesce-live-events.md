# F01 — Объединять события WebSocket: одно обновление store и одна транзакция на пачку

**Приоритет:** P1 (производительность) · **Область:** `client/src/lib/sync`, `client/src/lib/store`, `client/src/lib/db` · **Зависит от:** —

## Проблема

`SyncEngine.handleEvent` (`client/src/lib/sync/engine.ts`) обрабатывает каждое событие сокета отдельно и синхронно:

- `track.status` → `store.patchTrack(...)` (новая ссылка `tracks`, уведомление **всех** подписчиков библиотеки)
  и `db.patchTrack(...)` — отдельная транзакция IndexedDB «прочитать + записать» на каждое событие;
- `job.progress` / `download.progress` / `stream.progress` → `live.set…Progress`, каждое копирует всю карту
  (`new Map(s.albumProgress)`).

При импорте дискографии или массовом повторе поиска сервер шлёт сотни–тысячи `track.status` и `job.progress`
подряд. На каждое событие: запускаются селекторы всех смонтированных строк и карточек, пересчитывается «следующий
трек» плеера (`onLibraryChanged` → `syncNext`), хуки с зависимостью от `s.tracks` (см. F03) заново проходят
библиотеку. Списки библиотеки защищены троттлингом 250 мс (`useLibraryList`), остальное — нет.

Дополнительно карты `live` не очищаются: `albumProgress` удаляет запись только при завершённой стадии `verifying`
(альбом, закончивший поиск без раздач, остаётся навсегда), `downloadProgress` не удаляет никогда. При массовом
импорте карта растёт до тысяч записей, и каждое событие копирует её целиком.

## Текущее состояние (прочитай перед началом)

- `client/src/lib/sync/engine.ts` — `handleEvent`, `applyChanges`, `snapshot`, `stop`.
- `client/src/lib/store/library.ts` — `patchTrack`, `Table`, `TableDraft`.
- `client/src/lib/store/live.ts` — три карты прогресса.
- `client/src/lib/db/index.ts` — `patchTrack` (IndexedDB и запасной вариант в памяти).
- Тесты: `client/src/lib/sync/engine.test.ts`, `client/src/lib/store/library.test.ts`, `live.test.ts`,
  `client/src/lib/store/perf.test.ts`, `client/tests/perf/budgets.spec.ts`.

## Что сделать

1. **Буфер событий в движке.** В `createSyncEngine` завести буфер: `Map<trackId, TrackPatch>` для `track.status`
   (последнее событие по треку побеждает) и по карте на каждый вид прогресса. Первое событие ставит таймер
   `setTimeout(flush, LIVE_FLUSH_MS)` (константа, 50 мс, экспортировать для тестов); `flush` применяет всё разом.
   `sync.poke` и `resync` обрабатываются сразу, как сейчас (`resync` перед очисткой `live` сбрасывает буфер прогресса).
2. **Пакетные операции.**
   - `LibraryActions.patchTracks(patches: ReadonlyMap<number, TrackPatch>)` — одно `set`, одна новая ссылка `tracks`;
     `patchTrack` выразить через него.
   - `Db.patchTracks(patches)` — одна транзакция `readwrite` на всю пачку (и в запасной реализации в памяти).
   - `live.applyProgress({ album?, download?, stream? })` — одно `set`, каждая затронутая карта копируется один раз.
3. **Порядок относительно дельты.** Отложенный патч не должен перезаписать более свежую строку из дельты:
   в `applyChanges` и перед `replaceAll` в `snapshot` сначала вызвать `flush()` (до записи пачки в базу и store).
   В `stop()` — отменить таймер и отбросить буфер.
4. **Очистка карт прогресса** (в `flush`):
   - `downloadProgress`: запись удаляется, когда `bytes_total > 0 && bytes_done >= bytes_total`;
   - `albumProgress`: для альбомов, по которым в этой пачке пришли `track.status`, запись удаляется, если после
     применения патчей в store у альбома нет треков `adding` (`tracksByAlbum` → `tracks`).
5. Вкладки-ведомые получают состояние от лидера пачками (`tabs.post`) — их путь не меняется.

## Тесты (обязательные)

`engine.test.ts` (фейковые таймеры `vi.useFakeTimers()`):

- `coalesces track.status into one store update`: 500 событий подряд → до истечения `LIVE_FLUSH_MS` store не менялся,
  после — ровно одно уведомление подписчика и один вызов `db.patchTracks` с 500 записями.
- `last status per track wins`.
- `flushes pending patches before applying a delta`: событие `adding` в буфере, затем дельта с тем же треком в `found`
  → итог `found`.
- `stop drops pending events`.
- `clears album progress when the album has no adding tracks`; `clears finished download progress`.

`library.test.ts`: `patchTracks` — одно обновление, отсутствующие id пропускаются. `db` — тест `patchTracks`
на `fake-indexeddb`. `live.test.ts`: `applyProgress`.

`perf.test.ts`: добавить замер «1000 событий `track.status` при 60 000 треках» — время обработки и число
уведомлений подписчика (должно быть ≤ числа интервалов сброса, а не 1000). Цифру «до/после» — в Журнал
`docs/review/README.md`.

## Критерии приёмки

- `just client-test`, `just check` зелёные; `just client-perf` не хуже текущих бюджетов.
- Существующие тесты, ожидавшие синхронного применения `track.status`, переведены на продвижение таймера
  (`vi.advanceTimersByTime(LIVE_FLUSH_MS)`) или на `engine.settled()` (сделать, чтобы `settled()` дожидался сброса буфера).
- e2e (`just client-e2e`): статус трека по событию по-прежнему меняется без перезагрузки.

## Подводные камни

- Плеер ждёт `found` текущего трека через подписку на библиотеку — задержка 50 мс допустима, но тесты плеера
  с фейковым движком могут опираться на синхронность.
- `requestAnimationFrame` не использовать: в фоновой вкладке он не срабатывает, а события должны применяться.
