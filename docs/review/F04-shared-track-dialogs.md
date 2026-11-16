# F04 — Общие диалоги для строк треков вместо диалогов в каждой строке

**Приоритет:** P2 · **Область:** `client/src/components/player`, `components/library`, `components/offline`, `components/playlists`, `components/sources` · **Зависит от:** — · **Закрывает:** `docs/backlog.md` C9

## Проблема

`PlayableTrackRow` (`client/src/components/player/play-buttons.tsx`) в **каждой** строке создаёт и монтирует:

- два `Ariakit.useDialogStore()` и два компонента-диалога (`AddToPlaylistDialog`, `TrackSourceDialog`) — содержимое
  монтируется только при открытии (`unmountOnHide`), но обёртка `Dialog` с её хуками (`useIsMobileWidth`,
  `useSheetDrag`) живёт в каждой строке;
- `RowMenu` со своим `MenuProvider` и `useTrackOfflineMenu`, внутри которого ещё один `useDialogStore` и
  `ConfirmDialog`.

Итого на строку — три хранилища диалогов, хранилище меню и три смонтированных оболочки окон; в виртуальном списке
всё это создаётся и уничтожается при прокрутке. Кроме того:

- одна и та же подписка берётся в строке несколько раз: `useTrackView(id)` — в `useToggleTrack`,
  в `PlayableTrackRow` и в `TrackRowById`; `useTrackOffline(trackId)` — в `TrackAvailability` и повторно во вложенном
  `TrackOfflineIndicator`, плюс в `useTrackOfflineMenu`;
- **backlog C9**: открытый диалог принадлежит строке — если строка размонтируется (прокрутка виртуального списка,
  трек ушёл из отфильтрованного списка после смены статуса), диалог закрывается сам.

## Текущее состояние (прочитай перед началом)

- `client/src/components/player/play-buttons.tsx` — `useToggleTrack`, `PlayableTrackRow`.
- `client/src/components/library/row-menu.tsx`, `connected.tsx` (`TrackRowById`), `track-row.tsx`.
- `client/src/components/offline/track-offline.tsx` — `TrackAvailability`, `TrackOfflineIndicator`, `useTrackOfflineMenu`.
- `client/src/components/playlists/add-to-playlist-dialog.tsx`, `components/sources/track-source-dialog.tsx`,
  `components/ui/dialog.tsx`, `ui/confirm-dialog.tsx`.
- `client/src/components/player/track-menu.tsx` (меню трека в плеере — те же диалоги), `components/app-shell.tsx`.
- Тесты компонентов рядом с файлами (`*.test.tsx`), e2e `client/tests/e2e`, аудит `client/tests/audit/screens.ts`.

## Что сделать

1. **Хост диалогов трека.** Новый модуль `client/src/components/library/track-dialogs.tsx`:
   - `TrackDialogsProvider` — монтируется один раз в оболочке (`app-shell.tsx`, внутри провайдеров i18n/query);
     держит состояние `{ kind: 'playlist' | 'source' | 'offline-cover', trackId, … } | null` и по одному экземпляру
     `AddToPlaylistDialog`, `TrackSourceDialog`, `ConfirmDialog` (закрепление альбома/плейлиста);
   - `useTrackDialogs()` → `{ addToPlaylist(trackId), chooseSource(trackId), confirmOfflineCover(args) }` —
     стабильные функции.
   Название трека и `albumId` диалог берёт сам по `trackId` (`useTrackView`), а не из пропсов строки — строка может
   исчезнуть, диалог остаётся открытым; если трек удалён из библиотеки — диалог закрывается.
2. **Строка без собственных диалогов.** `PlayableTrackRow` и `RowMenu` вызывают `useTrackDialogs()`; из них
   удаляются `useDialogStore`, оба диалога и `offlineMenu.dialog`. `useTrackOfflineMenu` возвращает только пункт меню
   (подтверждение открывает через хост). `track-menu.tsx` плеера перевести на тот же хост.
3. **Меню строки** оставить в строке (`MenuProvider` лёгкий, содержимое `MenuSheet` должно монтироваться только при
   открытии — проверить; если `MenuSheet` рендерит пункты всегда, включить `unmountOnHide`).
4. **Убрать повторные подписки.**
   - `PlayableTrackRow`: одна подписка `useTrackView(id)`; `useToggleTrack` принимает `view` аргументом;
     в `TrackRow` передавать готовый `track` (использовать `TrackRow` + `useAlbumProgress` напрямую вместо
     `TrackRowById`, который подписывается ещё раз). `TrackRowById` остаётся для мест без воспроизведения.
   - `TrackAvailability`: одна подписка `useTrackOffline`; `TrackOfflineIndicator` разделить на подписанный
     компонент и чистый `TrackOfflineIcon({ state })`, который и рисует `TrackAvailability`.
5. Убрать запись C9 из `docs/backlog.md`.

## Тесты (обязательные)

- `play-buttons.test.tsx` (или соседний): `row does not mount dialogs` — в DOM строки нет диалоговых узлов до
  открытия; `opening "add to playlist" from the row menu shows the shared dialog`;
  `choose source opens the shared dialog with the row's track`.
- `track-dialogs.test.tsx`: `dialog stays open when its row unmounts` (регрессия C9: открыть диалог, убрать строку из
  списка — диалог на месте); `dialog closes when the track disappears from the library`.
- Существующие тесты диалогов (`add-to-playlist-dialog`, `track-source-dialog`, офлайн-подтверждение) — зелёные,
  обёртка рендера (`src/test/render.tsx`) включает `TrackDialogsProvider`.
- e2e: сценарии «в плейлист» и «выбрать источник» из списка библиотеки, альбома и плеера проходят.

## Критерии приёмки

- `just client-test`, `just check`, `just client-e2e`, `just client-audit` зелёные (фокус возвращается на кнопку меню
  после закрытия диалога; axe без новых нарушений).
- `just client-perf` не хуже текущих бюджетов; число подписок/хуков на строку — в Журнал (до/после, по профилю React
  или счётчику в тесте).

## Подводные камни

- Возврат фокуса: Ariakit возвращает фокус на элемент, открывший диалог (`disclosure`). Диалог теперь открывается
  программно из пункта меню, который к моменту открытия уже размонтирован, — передавать хосту элемент кнопки «…»
  строки и выставлять `store.setDisclosureElement(...)`; если кнопки уже нет в DOM — фокус на контейнер списка.
- Полноэкранный плеер рисует меню выше остальных слоёв (`z-[70]` у диалога уже учтён) — проверить на мобильной вёрстке.
