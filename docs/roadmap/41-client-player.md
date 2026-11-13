# Шаг 41 — Плеер: движок, панель, очередь, полноэкранный режим

**Фаза 2 · Зависит от:** 39

## Зачем

Перенос плеера в новый клиент без потери поведения. Чистая логика (`engine.ts`) уже отделена от DOM и
переносится как есть; побочные эффекты (элемент `<audio>`, Media Session, сохранение состояния)
выносятся из React-провайдера в обычный модуль, чтобы плеер не зависел от перерисовок и навигации.
Всё, что касается воспроизведения звука и системных элементов управления, прячется за интерфейсом
`AudioEngine`: в PWA его реализует `<audio>` + Media Session, в нативных оболочках (шаг 53) — нативный
плеер. Контроллер и интерфейс плеера про `<audio>` не знают.

## Текущее состояние (источники для переноса; прочитай целиком)

- `web/providers/player/engine.ts` (373 строки) — редьюсер, очередь, shuffle/repeat, сериализация, учёт прослушивания. Переносится **без изменений логики**.
- `web/providers/player-provider.tsx` (601 строка) — `<audio>`, загрузка трека, обработка ошибок (`probeStreamError`), перемотка перекодируемых треков через `?t=`, сохранение в `localStorage`, Media Session, горячие клавиши, предзагрузка следующего, счётчик прослушиваний.
- `web/components/now-playing-bar.tsx` (770 строк) — панель, мобильный мини-плеер, полноэкранный плеер, жесты; `web/components/queue-panel.tsx`.
- `web/features/track/components/play-button.tsx`, `track-interactions.tsx`; `web/features/library/components/play-album-button.tsx`, `to-player-track.ts`; `web/features/playlists/components/player-track-menu.tsx`; `web/types/track.ts`.
- Тесты прежнего поведения: `web/tests/player-engine.spec.ts` (unit), `player.spec.ts` (336 строк), `full-player.spec.ts`.
- Бэкенд: `GET /api/tracks/{id}/stream` (Range; для `playback = transcode` — без Range, `?t=<сек>`, заголовки `X-Nimbus-*`), `POST /api/tracks/{id}/prefetch`, `POST /api/tracks/{id}/played`, событие `stream.progress`.

## Что сделать

1. **`src/lib/player/engine.ts`** — копия `web/providers/player/engine.ts`; тип `Track` плеера строится из `trackView` (перенеси `to-player-track.ts`).
   `web/tests/player-engine.spec.ts` перенести в Vitest целиком (это основа покрытия).
2. **`src/lib/player/audio/` — граница `AudioEngine`** (контракт для шага 53; менять только вместе с ним):
   ```ts
   interface AudioEngine {
     readonly capabilities: { gapless: boolean; nativeNowPlaying: boolean; backgroundSafe: boolean; headers: boolean };
     load(src: AudioSource, opts: { startAt: number; autoplay: boolean; positionOffset?: number }): void; // синхронно (жест iOS); positionOffset — для ?t= у transcode
     play(): Promise<void>; pause(): void; seek(seconds: number): void; setVolume(v: number): void;
     preloadNext(src: AudioSource | null): void;          // следующий трек; web — предзагрузка, native — очередь плеера (gapless)
     setNowPlaying(meta: NowPlaying | null): void;        // название, артист, альбом, обложка, длительность
     getPosition(): { current: number; duration: number; buffered: [number, number][] };
     on(handler: (e: AudioEvent) => void): () => void;   // loading | playing | paused | waiting | ended | error{code} | advanced | remote{action, seekTo?}
     dispose(): void;
   }
   type AudioSource = { url: string; mime?: string; headers?: Record<string, string>; mode: 'direct' | 'transcode' };
   ```
   - `advanced` — движок сам перешёл к `preloadNext` (нативный gapless); контроллер синхронизирует очередь, а не запускает следующий трек второй раз. Веб-реализация этого события не шлёт.
   - `remote` — команды экрана блокировки/гарнитуры/медиаклавиш (`play|pause|next|previous|seekto|seekforward|seekbackward`). Контроллер обрабатывает их так же, как кнопки интерфейса.
   - **`web-engine.ts`** — реализация на одном `HTMLAudioElement` (создаётся один раз вне React и добавляется в `document.body` скрытым, с `data-testid="player-audio"` — по нему e2e-тесты читают `currentTime`) + Media Session (`media-session.ts`, п. 3). `capabilities = { gapless: false, nativeNowPlaying: false, backgroundSafe: false, headers: false }` (в PWA заголовки не нужны — авторизация cookie; `AudioSource.headers` игнорируется).
   - **`fake-engine.ts`** (в `src/test/`) — управляемый фейк для unit-тестов контроллера.
   Выбор реализации — одна фабрика `createAudioEngine()` по `platform()` (шаг 36). Прямой доступ к `HTMLAudioElement` и `navigator.mediaSession` вне `web-engine.ts`/`media-session.ts` запрещён (правило линта `no-restricted-properties`/`no-restricted-globals`).
3. **`src/lib/player/controller.ts`** — класс `PlayerController` (не React), работает через `AudioEngine` и владеет zustand-store состояния (`PlayerState` из движка).
   В него переезжает всё из `player-provider.tsx`: загрузка и запуск трека, обработчики событий `<audio>`, буферизация, ошибки и их расшифровка, переход к следующему, перемотка (обычная и через `?t=` для перекодируемых),
   предзагрузка следующего трека, учёт прослушивания (`advanceListen` → `played` через outbox шага 37), сохранение/восстановление состояния (`localStorage`, ключ прежний — `nimbus:player`).
   Зависимости передаются в конструктор: `AudioEngine`, `resolveStreamUrl`, API, часы, хранилище — для тестов с фейковым движком.
   - **`resolveStreamUrl(track, startSeconds): Promise<AudioSource> | AudioSource`** — единственное место, где строится источник потока (`apiUrl('/api/tracks/{id}/stream[?t=]')` + `authHeaders()` из шага 36). Шаг 46 подменит его для офлайн-треков.
   - Очередь хранит **id треков**; актуальные данные трека (статус, название) читаются из библиотечного store в момент использования. Трек, удалённый из библиотеки, пропускается.
   - Возможность играть: `canPlay(track)` = статус `found|ready` (шаг 47 расширит условием офлайн-доступности) — одна функция, используемая и контроллером, и кнопками.
   - Предзагрузка следующего трека — через `engine.preloadNext()`; сохранение/учёт прослушивания не зависят от реализации движка.
4. **`src/lib/player/media-session.ts`, `shortcuts.ts`** — Media Session (метаданные, обложка, действия, позиция; действия превращаются в события `remote` движка) и горячие клавиши (пробел, стрелки и остальное — перенеси таблицу из провайдера, включая правила «не срабатывать в полях ввода»).
5. **Хуки `src/lib/player/hooks.ts`:** `usePlayerState(selector)`, `usePlayerActions()`, `useIsCurrentTrack(id)`, `useProgress()` (позиция обновляется через собственную подписку: `engine.getPosition()` по `requestAnimationFrame` при видимой вкладке, **не** через общий store — иначе вся панель перерисовывается 4 раза в секунду).
6. **Интерфейс (`src/components/player/`).** Перенос вёрстки и поведения `now-playing-bar.tsx` с разбиением на файлы: `player-bar.tsx` (настольная панель), `mini-player.tsx` (мобильная), `full-player.tsx` (полноэкранный, жесты смахивания),
   `seek-bar.tsx` (с отображением буфера — `toRanges`), `volume.tsx`, `transport.tsx`, `queue-panel.tsx`, `download-info.tsx` (`describeDownload` по `stream.progress`), `track-menu.tsx` (пока: «Перейти к альбому», «Перейти к артисту», «Убрать из очереди»; «В плейлист» добавит шаг 42).
   Монтируется в слот `data-slot="player"` оболочки. Анимации смены трека (`animate-track-next/prev`), `Marquee`, `Equalizer` — как сейчас.
7. **Кнопки запуска в экранах шага 39.** В слоты `TrackRow`, `AlbumCard`, шапок альбома/артиста/главной: `PlayButton` (трек в контексте списка: очередь = список, старт с этого трека), `PlayAlbumButton`, двойной клик/Enter по строке трека,
   индикатор текущего трека (`Equalizer`), недоступные треки приглушены и не запускаются (перенеси `track-interactions.tsx`).
   Очереди формируются теми же правилами, что сейчас (альбом — его доступные треки по порядку; «Готово к прослушиванию» — весь список).
8. **События.** `stream.progress` → `live`-store → `download-info`. `track.status` для текущего/следующего трека: если текущий трек ждал источника и стал `found` — продолжить; если следующий стал недоступен — пропустить.
9. **Мок и e2e.** Мок: поток (WAV-генератор и `wavFrom` из старого мока, Range, режим `transcode` с `?t=`, управляемые ошибки по списку треков), `HEAD` потока, `prefetch`, `played`. Запуск Chromium с `--autoplay-policy=no-user-gesture-required` (как в старом конфиге).

## Тесты (обязательные)

Unit (фейковый `AudioEngine` с управляемой позицией, буфером и событиями; `web-engine` — отдельно, на фейковом `HTMLAudioElement`):
- `web-engine`: `load` синхронно выставляет `src` и вызывает `play()` в том же тике при `autoplay`; события `<audio>` переводятся в `AudioEvent`; устаревшие события предыдущего `src` отбрасываются; действия Media Session → `remote`;
- контроллер на событии `advanced` сдвигает очередь без повторного `load` (заготовка под нативный gapless);
- команда `remote: next` ведёт себя как кнопка «Следующий» (одна и та же функция);
- перенесённый `player-engine` (все случаи);
- контроллер: запуск трека → `loading → playing`; конец трека → следующий доступный; `repeat one/all`; `shuffle` включить/выключить сохраняет текущий трек; `previous` перезапускает трек после 3 с;
- ошибка потока → расшифровка через `HEAD` → состояние `error` с кодом → автопереход к следующему (как сейчас) / остановка на последнем;
- перемотка перекодируемого трека меняет адрес на `?t=` и корректирует отображаемую позицию; обычного — меняет `currentTime`;
- сохранение: состояние пишется не чаще, чем раньше (сверь интервал), восстанавливается после «перезапуска» в паузе на той же позиции; повреждённое значение в `localStorage` игнорируется;
- прослушивание: `played` отправляется один раз после порога (`playCountThreshold`), перемотка вперёд не засчитывается; без сети — уходит в outbox;
- предзагрузка: `prefetch` следующего трека вызывается один раз и только если включено в настройках воспроизведения (как сейчас — проверь, откуда берётся флаг);
- трек удалён из библиотеки во время игры следующего → пропуск без ошибки;
- Media Session: метаданные и обработчики выставляются, позиция обновляется; горячие клавиши не срабатывают в полях ввода.

Компонентные: панель показывает текущий трек, состояния кнопок, буфер на полосе; очередь — перестановка/удаление/переход; полноэкранный режим открывается и закрывается (кнопка, Esc).

E2E (перенос `player.spec.ts`, `full-player.spec.ts` + новые):
- запуск альбома → звук идёт (`currentTime` растёт) → пауза → следующий → предыдущий;
- **навигация не прерывает звук:** во время игры пройти 5 экранов — `currentTime` монотонно растёт, элемент аудио тот же;
- перезагрузка страницы → трек и позиция восстановлены в паузе;
- перекодируемый трек: перемотка работает, время отображается верно;
- ошибка потока → сообщение и переход к следующему;
- мобильный размер: мини-плеер → полноэкранный → смахивание вниз закрывает; нижний отступ не перекрывает панель вкладок.

## Критерии приёмки

```
just client-check && just client-test && just client-cov && just client-e2e
```

Ручная проверка на реальном бэкенде (`just backend` + `just client`): трек `found` (ещё не скачан на сервер) начинает играть, виден прогресс загрузки; трек `ready` стартует мгновенно.
Результат — в Журнал. Если бэкенд недоступен в среде выполнения — так и записать.

## Не входит в шаг

- Офлайн-воспроизведение (46–47), добавление в плейлист из меню трека (42), настройки воспроизведения (43).

## Подводные камни

- Один элемент аудио на всё приложение и на всю жизнь вкладки. iOS разрешает запуск только из обработчика жеста: первый `play()` должен вызываться синхронно в цепочке клика — асинхронный `resolveStreamUrl` не должен отодвигать `play()` за пределы жеста для обычных (сетевых) треков. Решение: для сетевого трека `resolveStreamUrl` возвращает `AudioSource` синхронно (тип `AudioSource | Promise<AudioSource>`), и контроллер не делает `await`, если получил значение; `engine.load` тоже синхронный.
- Интерфейс `AudioEngine` проектируется под **обе** реализации: не протаскивай в него особенности `<audio>` (`readyState`, `TimeRanges`, `canplaythrough`). Если чего-то не выразить через контракт — расширь контракт и опиши в Журнале как изменение для шага 53.
- В `player-provider.tsx` много накопленных исправлений (гонки при быстром переключении, устаревшие события от предыдущего трека, iOS). Переноси по фрагментам с их комментариями; у каждого исправления должен остаться тест.
- Не клади `currentTime` в общий store — см. п. 5.
- React Compiler и объект контроллера: методы контроллера стабильны (стрелочные поля класса), их можно передавать в пропсы без `useCallback`.
