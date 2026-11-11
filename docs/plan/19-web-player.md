# Шаг 19 — Фронтенд: аудиоплеер и очередь

**Зависит от:** 11, 18
**Оценка:** 2 дня

## Цель

Заменить заглушку движка плеера (шаг 08) реальным воспроизведением через `HTMLAudioElement` с источником `${NEXT_PUBLIC_BACKEND_URL}/api/tracks/{id}/stream`. Очередь, next/prev, shuffle/repeat, перемотка, громкость, состояние буферизации, Media Session API. Сохранить UI плеер-бара next-beats.

## Обязательно прочитать

`docs/web-inventory.md`, раздел «Аудио» — интерфейс провайдера плеера, который ожидают компоненты. Сохрани этот интерфейс (или аккуратно расширь), чтобы не переписывать потребителей.

## Что сделать

### 1. Движок (`providers/player/engine.ts`)

- Один `HTMLAudioElement` на приложение (создаётся в клиентском провайдере, живёт в `useRef`, не пересоздаётся при навигации — провайдер в корневом layout).
- `audio.preload = "auto"`; `crossOrigin = "anonymous"` (нужно для Web Audio визуализатора, бэкенд отдаёт CORS-заголовки из шага 03 — проверить, что `Access-Control-Expose-Headers` включает `Content-Range, Accept-Ranges, Content-Length`).
- Состояние (React context + `useSyncExternalStore` или `zustand`):
  ```ts
  type PlayerState = {
    queue: QueueItem[];           // { track: TrackDto, source: "album"|"library"|"search"|... }
    index: number;                // текущий
    status: "idle" | "loading" | "buffering" | "playing" | "paused" | "error";
    error?: { code: string; message: string };
    position: number;             // сек, throttled 4 раза/с
    duration: number;             // сек (из audio.duration, иначе track.duration_ms)
    buffered: [number, number][]; // для полоски буфера
    volume: number; muted: boolean;
    shuffle: boolean; repeat: "off" | "all" | "one";
    download?: { bytes_done: number; bytes_total: number; peers: number; down_speed_bps: number }; // из stream.progress
  };
  ```
- Действия: `playTrack(track, context?: TrackDto[])` (ставит очередь из контекста — альбом/список — и играет выбранный), `togglePlay`, `next`, `prev` (если позиция > 3 с — в начало трека), `seek(sec)`, `setVolume`, `toggleMute`, `toggleShuffle`, `cycleRepeat`, `enqueue(track)`, `playNext(track)`, `removeFromQueue(i)`.
- Пропускать в очереди треки, не находящиеся в `found`/`ready` (с учётом live-оверрайдов статусов из шага 11).
- События `audio`: `waiting`/`stalled` → `buffering`; `playing` → `playing`; `ended` → `next` (с учётом repeat); `error` → разобрать: при `MEDIA_ERR_SRC_NOT_SUPPORTED` сделать `fetch(src, {method:"HEAD"})` и показать код бэкенда (`track_not_playable`, `transcode_required`, `no_peers`, `cue_not_supported`) в toast; автоматически перейти к следующему треку через 2 с.
- `stream.progress` из WebSocket для текущего трека → `download` (показать под прогресс-баром: «Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с», пока не `ready`).
- Сохранять громкость, shuffle, repeat в `localStorage`; очередь и позицию — тоже (восстановить на паузе после перезагрузки).

### 2. Холодный старт

Первый байт с торрента может идти 5–30 с. Показывать в плеер-баре состояние «Подключаемся к раздаче…» (статус `loading`/`buffering` + `download.peers`), кнопку отмены. Не считать долгое ожидание ошибкой до 60 с (таймаут бэкенда).

### 3. Media Session API

`navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork: [{ src: cover_url, sizes: "500x500" }] })`, обработчики `play, pause, previoustrack, nexttrack, seekto, seekbackward, seekforward`, `setPositionState` раз в секунду.

### 4. UI

- Плеер-бар next-beats: обложка, название (ссылка на альбом), артист (ссылка), кнопки, прогресс с полоской `buffered`, громкость, кнопка очереди.
- Панель очереди (выезжающая справа): текущий, «Далее», перетаскивание — опционально.
- Кнопки Play в строках треков / шапке альбома («Слушать альбом» → очередь из `found`/`ready` треков альбома).
- Горячие клавиши: `Space` — play/pause (если фокус не в инпуте), `←/→` — ±5 с, `Shift+←/→` — prev/next.
- Визуализатор (опционально, если в next-beats был визуальный элемент на Web Audio — подключить `AnalyserNode` к `MediaElementAudioSourceNode`).

## Тесты (Playwright)

- Мокнуть `**/api/tracks/*/stream` маленьким реальным аудиофайлом-фикстурой (`tests/fixtures/sine.mp3`, 5 с, сгенерировать через `ffmpeg -f lavfi -i sine=frequency=440:duration=5 -b:a 64k sine.mp3`) с поддержкой Range (или отдать целиком с `200`).
- Сценарии: клик Play → `audio.paused === false` через `page.evaluate`, плеер-бар показывает трек; `ended` → следующий трек; ошибка (`415`) → toast и переход дальше; Media Session metadata установлена.
- Запуск Chromium с `--autoplay-policy=no-user-gesture-required`.

## Критерии приёмки

- `just web-check`, `pnpm build`, Playwright проходят.
- Сквозная ручная проверка с живым бэкендом: добавить альбом → дождаться `found` → нажать Play → музыка играет, перемотка работает, после полной загрузки трек становится `ready`.

## Вне рамок шага

Выбор источника вручную (шаг 20), prefetch следующего трека (шаг 22).
