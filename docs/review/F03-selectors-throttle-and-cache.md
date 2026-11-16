# F03 — Проходы по всей библиотеке в нетроттлированных хуках; кэши селекторов без предела

**Приоритет:** P2 · **Область:** `client/src/lib/store` · **Зависит от:** F01 (после него обновлений store в разы меньше; задача выполнима и без него)

## Проблема

Селекторы (`client/src/lib/store/selectors.ts`) мемоизированы по ссылкам таблиц. Любое изменение любого трека
(статус, счётчик прослушиваний) даёт новую ссылку `s.tracks`, и каждый селектор с зависимостью от `s.tracks`
пересчитывается целиком при следующем чтении.

1. **Тяжёлые хуки подписаны напрямую.** `useLibraryList`/`useLibraryCounts` читают через `createThrottledSource`
   (не чаще раза в 250 мс), а остальные «по всей библиотеке» — через обычный `useLibrary`, т. е. пересчёт на каждое
   обновление store:

   | Хук | Где смонтирован | Что делает на каждое изменение `tracks` |
   |---|---|---|
   | `useRecentlyPlayedAlbums` | главная | проход по всем трекам |
   | `useFavorites` | главная, плейлист «Избранное» | фильтр и сортировка всех прослушанных |
   | `usePlaylistCards` | вкладка плейлистов, диалог | `favorites` + обход плейлистов |
   | `useMbidIndex` | экран поиска | три карты по всей библиотеке |
   | `useSearchLocal` | поиск, командная палитра | три списка библиотеки + фильтр |

2. **`artistView` не мемоизируется по сути**: в зависимостях `s.albums` и `s.tracks` целиком, поэтому после любого
   изменения любого трека пересчитываются представления всех артистов (при пересчёте `libraryArtists`).
3. **Кэш `lists` и кэши представлений растут без предела.** Ключи `search:${q}:${limit}` (на каждый набранный
   префикс), `albumTracks:${id}`, `artistAlbums:…`, `artistTracks:…`, `member:${trackId}` (на каждую когда-либо
   показанную строку трека), `playlist:${id}` никогда не удаляются; `trackViews`/`albumViews`/`artistViews` хранят
   записи удалённых из библиотеки сущностей. За долгую сессию PWA это тысячи массивов и объектов.

## Текущее состояние (прочитай перед началом)

- `client/src/lib/store/selectors.ts` — `memoByKey`, `createSelectors`.
- `client/src/lib/store/hooks.ts` — `useLibrary`, `useLibraryList`, `createThrottledSource`.
- `client/src/lib/store/throttled.ts`.
- Тесты: `selectors.test.ts`, `perf.test.ts`, `client/tests/perf/budgets.spec.ts`.

## Что сделать

1. **Общий хук с троттлингом.** В `hooks.ts` выделить `useThrottledLibrary<T>(select, deps, isEqual?)` — обёртка над
   `createThrottledSource` + `useSyncExternalStore` (сейчас этот код дважды повторён в `useLibraryList` и
   `useLibraryCounts`) и перевести на неё: `useRecentlyPlayedAlbums`, `useFavorites`, `usePlaylistCards`,
   `usePlaylistCard`, `useMbidIndex`, `useSearchLocal`. `useLibraryList`/`useLibraryCounts` — тоже через неё.
   Точечные хуки (`useTrackView`, `useAlbumView`, `useArtistView`, `useAlbumTracks`, `usePlaylistTracks`,
   `usePlaylistsOfTrack`) остаются мгновенными.
   Проверить поведение при смене аргументов (`query` в `useSearchLocal`): первое значение для нового аргумента
   должно вычисляться сразу (так уже работает `getSnapshot` нового источника).
2. **Точные зависимости `artistView`.** Убрать из зависимостей `s.albums` и `s.tracks`; зависеть от самой строки
   артиста, `albumsByArtist.get(id)`, `tracksByArtist.get(id)`, строк его альбомов, `tracksByAlbum.get(albumId)` для
   каждого альбома и **агрегата по флагам `in_library`** его треков. Чтобы не перечислять все строки треков в
   зависимостях, считать результат (`albumCount`, `trackCount`) всегда (это дёшево — треки одного артиста), а
   мемоизировать по значению: если счётчики и строка артиста те же — вернуть прежний объект `ArtistView`.
   Добавить в `memoByKey` вариант «сравнить результат» (`reuse(prev, next) => boolean`).
3. **Ограниченный кэш списков.** `lists` заменить на LRU с пределом (например, 300 ключей; константа):
   при превышении удаляется давно не использованный ключ. Ключи без параметров (`favorites`, `mbidIndex`,
   `playlistCards`, списки библиотеки) живут в нём же — они всегда «свежие».
   Важно для `useSyncExternalStore`: вытесненный ключ, прочитанный снова при тех же данных, вернёт **новую** ссылку —
   смонтированный компонент читает свой ключ на каждом уведомлении, поэтому его ключ не устаревает; предел должен
   быть заметно больше числа одновременно смонтированных подписчиков (виртуальный список — десятки строк).
   Это проверить тестом (п. «Тесты»).
4. **Уборка кэшей представлений.** Метод `selectors.prune(s)`: удалить из `trackViews`/`albumViews`/`artistViews`
   записи, id которых больше нет в соответствующих таблицах. Вызывать из `app-data.ts` после `replaceAll` (снимок)
   и после пачки с удалениями (`batch.deleted?.length`).

## Тесты (обязательные)

`selectors.test.ts`:

- `artistView keeps identity when an unrelated track changes`; `artistView updates when a track's in_library flips`;
  `…when an album is added to the artist`.
- `lists cache is bounded`: 1000 разных запросов `searchLocal` → размер кэша ≤ предела (экспортировать
  `selectors.cacheSize()` только для тестов).
- `evicted key recomputes to an equal value`; `a key read on every update is never evicted while 299 others rotate`.
- `prune drops views of deleted rows`.

`hooks` (новый `hooks.test.tsx` или существующий): `useFavorites` при серии из 100 обновлений статусов за 100 мс
пересчитывается не более двух раз (шпион на селектор, фейковые таймеры).

`perf.test.ts`: замер «100 `patchTrack` подряд при 60 000 треках и смонтированной главной (recent + favorites)» —
«до/после» в Журнал `docs/review/README.md`.

## Критерии приёмки

- `just client-test`, `just check`, `just client-perf` зелёные; `just client-e2e` зелёный
  (главная, поиск, плейлисты показывают актуальные данные — задержка до 250 мс допустима).

## Не входит

- Инкрементальные (без полного прохода) списки библиотеки и поэтапная гидрация (backlog C1).
