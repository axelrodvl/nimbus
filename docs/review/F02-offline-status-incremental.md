# F02 — Офлайн-менеджер: не пересобирать всё состояние на каждый тик прогресса

**Приоритет:** P1 (производительность) · **Область:** `client/src/lib/offline` · **Зависит от:** —

## Проблема

`publish()` в `client/src/lib/offline/manager.ts` вызывается на **каждое** сообщение `progress` от загрузчика
(раз в 250 мс на каждую идущую загрузку, `PROGRESS_INTERVAL_MS`; параллельно идут несколько) и каждый раз строит
состояние заново:

- новая `Map` и **новый объект статуса для каждого файла** (`statusOf(f)`), хотя изменился один;
- новый `Set` закреплений и новый объект `pinTimes` (`Object.fromEntries`), хотя закрепления не менялись.

Из-за этого все подписчики считают, что изменилось всё:

- `playback.ts` (`syncDone`) на каждое изменение `files` строит `Set` всех скачанных id и сравнивает с прежним;
- `player/index.ts` (`subscribeLibrary`) пересчитывает число скачанных файлов полным проходом;
- `useOfflineSummary` для каждой видимой карточки альбома заново собирает и сортирует id треков (`albumTrackIds`);
- `usePinSummaries` (вкладка «На устройстве») пересчитывает сводки всех закреплений;
- `useDownloadedSets` (фильтр «Только скачанные») пересобирает множества по всей библиотеке;
- `useQueueProgress`, `queueStatus` — полный проход по файлам.

Стоимость растёт линейно от числа закреплённых треков: при «скачать всю библиотеку» это тысячи файлов × несколько
публикаций в секунду на всё время загрузки, на телефоне.

## Текущее состояние (прочитай перед началом)

- `client/src/lib/offline/manager.ts` — `publish`, `statusOf`, `pinTimes`, `onMessage`, `pump`, `scheduleBroadcast`.
- `client/src/lib/offline/status.ts` — `OfflineStatus`, `toSnapshot`/`fromSnapshot`.
- `client/src/lib/offline/playback.ts` — `syncDone` и подписка на `status`.
- `client/src/lib/offline/hooks.ts`, `derive.ts` — потребители.
- `client/src/lib/player/index.ts` — `subscribeLibrary`.
- Тесты: `client/src/lib/offline/manager.test.ts`, `hooks.test.tsx`, `derive.test.ts`, `playback.test.ts`.

## Что сделать

1. **Стабильные ссылки.** В менеджере хранить последний опубликованный статус каждого файла
   (`Map<trackId, OfflineFileStatus>`): в `publish` для файла создавать новый объект, только если отличается хотя бы
   одно поле (`state`, `bytesDone`, `bytesTotal`, `mime`, `error`), иначе класть прежний. Карту `files` в store
   заменять новой, только если изменилась хотя бы одна запись или состав. `pins` и `pinTimes` пересоздавать только
   после изменения закреплений (флаг `pinsDirty`, выставляется в `pin`, `unpin`, `reloadFromDb`, сверке, `clear`).
   Если не изменилось ничего — `status.setState` не вызывать.
2. **Счётчик набора скачанных.** В `OfflineStatus` добавить `doneRevision: number` — растёт, когда какой-либо файл
   вошёл в состояние `done` или вышел из него (считается в `publish` при сравнении записей). Включить в
   `toSnapshot`/`fromSnapshot` (ведомая вкладка берёт значение лидера).
   - `playback.ts`: `syncDone` запускать только при смене `doneRevision` (и при `broken`).
   - `player/index.ts`: вместо подсчёта `done` — сравнение `doneRevision`.
   - `useDownloadedSets`: зависимость — `doneRevision`, а не ссылка `files`.
3. **Троттлинг прогресса.** Сообщение `progress` не публикует сразу, а помечает «нужна публикация»; публикация
   прогресса — не чаще `PROGRESS_PUBLISH_MS` (250 мс, один общий таймер на все загрузки, «хвостовой» вызов обязателен).
   Смена состояния файла (`done`, ошибка, старт, постановка в очередь), закреплений, паузы, блокировки — публикуется
   немедленно, как сейчас. При остановке менеджера таймер снимается.
4. **Сводки по строке.** `useOfflineSummary` вызывает `getIds()` на каждое изменение обоих store. Для
   `useAlbumOffline`/`usePlaylistOffline` кэшировать список id по ссылкам `lib.tracksByAlbum.get(albumId)` и
   `lib.tracks` (для плейлиста — `tracksByPlaylist.get(id)`, `playlistTracks`, `tracks`): пока они те же, id не
   пересобирать. Реализовать маленьким мемоизатором внутри хука (`useRef`), без изменения `derive.ts`.

## Тесты (обязательные)

`manager.test.ts`:

- `progress keeps unrelated file statuses referentially equal`: два файла, прогресс по одному → объект статуса второго
  тот же (`toBe`), `pins` и `pinTimes` — те же ссылки.
- `progress publishes are throttled`: 20 сообщений `progress` за 100 мс (фейковые таймеры) → не больше двух обновлений
  store; последнее значение прогресса опубликовано после `PROGRESS_PUBLISH_MS`.
- `state changes publish immediately`: `done` виден в store без продвижения таймера.
- `doneRevision changes only when the done set changes`: прогресс не меняет; `done`, удаление скачанного файла,
  возврат в очередь (повреждён) — меняют.
- `no setState when nothing changed`.

`playback.test.ts`: `version()` не меняется от прогресса чужой загрузки. `hooks.test.tsx`: `useAlbumOffline` не
перерисовывает компонент при прогрессе трека другого альбома (счётчик рендеров).

Замер в `client/src/lib/store/perf.test.ts` или новом `offline/perf.test.ts`: 5 000 файлов, 100 сообщений прогресса —
время и число уведомлений; «до/после» — в Журнал `docs/review/README.md`.

## Критерии приёмки

- `just client-test`, `just check` зелёные; покрытие клиента не ниже порога (`just client-cov`).
- Формат сообщения между вкладками остаётся совместимым: старая вкладка без `doneRevision` в снимке не ломается
  (`fromSnapshot` подставляет значение по умолчанию).

## Не входит

- Изменение числа попыток и расписания повторов скачивания на устройство (`MAX_ATTEMPTS`, `RETRY_DELAYS_MS`).
