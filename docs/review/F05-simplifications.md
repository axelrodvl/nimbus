# F05 — Упрощения без изменения поведения

**Приоритет:** P3 (поддерживаемость) · **Область:** `client/src/screens`, `client/src/lib` · **Зависит от:** — (п. 3 пересекается с F03 — если F03 выполнен, пропусти)

Четыре независимых небольших рефакторинга. Поведение и вёрстка не меняются: существующие тесты, e2e и аудит
скриншотов должны остаться зелёными **без правок ожиданий**. Коммит один; если пункт оказался неприменим
(код изменился) — пропусти и запиши в Журнал.

## 1. Три одинаковых списка в `library.tsx`

`client/src/screens/library/library.tsx`: `AlbumsList`, `ArtistsList`, `TracksList` повторяют один конвейер —
`STATUS_FILTERS.find(...)` → `useLibraryList(kind, statuses)` → фильтр «только скачанные» → `filterByName(..., useDeferredValue(q), name)`
→ `<Empty …/>` при пустом результате. Отличаются видом (`'albums' | 'artists' | 'tracks'`), полем названия, множеством
из `DownloadedSets` и отрисовкой.

**Сделать:** хук `useFilteredLibraryList(kind, { q, status, downloaded })` → `{ all, items }` (в том же файле или
`client/src/lib/library/use-filtered-list.ts`); три компонента оставить, но свести к вызову хука и отрисовке.
Типизация — через существующий `ListOf[K]` из `store/hooks.ts` (экспортировать тип).

## 2. `server-sections.tsx` — 497 строк, шесть разделов настроек в одном файле

`client/src/screens/settings/server-sections.tsx` содержит `SourcesSection`, `SearchSection`, `MusicbrainzSection`,
`PlaybackSection`, `StorageSection`, `PerformanceSection` и их вспомогательные компоненты (`ProviderTest`,
`FormatOrder`, `ReleaseTypes`, `ResetMusicbrainz`, `StorageUsage`, `DefaultButton`).

**Сделать:** каталог `client/src/screens/settings/server/` — по файлу на раздел (`sources.tsx`, `search.tsx`,
`musicbrainz.tsx`, `playback.tsx`, `storage.tsx`, `performance.tsx`), общий тип `SectionProps` — в `types.ts` рядом;
`server-sections.tsx` удалить, импорты в `settings-screen.tsx` обновить. Только перенос: ни строк текста, ни
`data-testid`, ни порядка элементов не менять. Тесты разделов (если лежат рядом) перенести вместе с кодом.

## 3. Дублирование троттлированного источника в `store/hooks.ts`

`useLibraryList` и `useLibraryCounts` дважды повторяют `useMemo(() => createThrottledSource(...)) + useSyncExternalStore`,
а `statusKeyOf` в `hooks.ts` дублирует `statusKey` из `selectors.ts`.

**Сделать:** общий `useThrottledLibrary(select, deps, isEqual?)`; `statusKey` экспортировать из `selectors.ts` и
использовать в `hooks.ts`.

## 4. Литерал ключа хранилища плеера

`client/src/lib/player/index.ts`, `resetPlayer`: `localStorage.removeItem('nimbus:player')` — строка продублирована
вместо константы `STORAGE_KEY` из `./engine`. Заменить на константу.

## Тесты

Новых тестов поведение не требует. Обязательно:

- для п. 1 — unit-тест хука `useFilteredLibraryList` (фильтр по статусу, по подстроке, «только скачанные», пустой
  результат) — он заменяет три неявно проверяемых копии;
- `just client-test`, `just client-e2e`, `just client-audit` — зелёные без изменения эталонов и ожиданий.

## Критерии приёмки

- `just check` зелёный; размер начального бандла не вырос (`bun run build` проверяет `bundle-budget.json`).
- `git diff --stat` для п. 2 — только перемещения (содержимое функций не изменено).

## Не входит

- Изменение вёрстки, текстов и набора настроек.
- Рефакторинг `player/controller.ts` и `offline/manager.ts`: крупные, но цельные модули с полным покрытием — дробить
  их не нужно.
