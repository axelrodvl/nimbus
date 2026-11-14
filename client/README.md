# Nimbus client

Одностраничное приложение (Vite + React 19 + TypeScript) на bun. Заменит `web/` (Next.js) на шаге 48;
правила — `docs/DEVELOPMENT.md` §5–6. Сейчас — оболочка, локальные данные, экраны библиотеки, поиск (локальный сразу + MusicBrainz, добавление в библиотеку, командная палитра) и плеер (панель, мини-плеер, полноэкранный режим, очередь).

## Команды

Из корня репозитория: `just client` (dev, :5173, прокси `/api` → `VITE_BACKEND_URL`, по умолчанию `http://localhost:8080`),
`just client-check` (lint + typecheck), `just client-test`, `just client-cov` (пороги в `vitest.config.ts`),
`just client-build`, `just client-e2e` (Playwright против `vite preview` и `tests/mock-backend.ts`),
`just client-gen-api` (OpenAPI → `src/lib/api/schema.d.ts`).

В каталоге `client/`: `bun install --frozen-lockfile`, `bun run dev | build | lint | typecheck | test | test:cov | test:e2e | gen:api`.
Один раз для e2e: `bunx playwright install chromium`.

## Структура

```
index.html               корень; инлайн-скрипт темы ставит класс до первой отрисовки
src/main.tsx app.tsx router.tsx
src/styles/              tokens.css (@theme), base.css, animations.css, index.css
src/components/ui/       примитивы (button, skeleton, spinner, empty/error-state, error-boundary, …)
src/components/player/   плеер: панель, мини-плеер, полноэкранный режим, очередь, кнопки запуска (`play-buttons.tsx`)
src/components/search/   поиск: результаты, кнопка добавления, командная палитра (⌘K, `/`)
src/components/          оболочка: app-shell, sidebar, mobile-tab-bar, session-routes (защита маршрутов), индикаторы
src/app-routes.tsx       маршруты внутри оболочки; пункты навигации появляются сами (src/lib/nav/items.ts)
src/screens/             экраны: главная, библиотека, артист, альбом (39), поиск (40)
src/lib/api/             openapi-fetch клиент, ApiError, сгенерированный schema.d.ts (не править)
src/lib/platform/        apiUrl()/wsUrl()/authHeaders()/platform() — единственное место адресов бэкенда
src/lib/i18n/            словари (en в бандле, остальные — по требованию), store, провайдер, useT/useLocale
src/lib/db/              IndexedDB `nimbus` (idb): loadAll/applyBatch/replaceAll/outbox, запасной режим в памяти
src/lib/store/           library (zustand vanilla, Table + индексы), selectors, live, mutations, hooks
src/lib/sync/            движок синхронизации (снимок/дельта/события), вкладки (Web Locks + BroadcastChannel), статус
src/lib/app-data.ts      сборка db + store + движок + сокет + мутации; `appData()` — синглтон, `resetAppData()`
src/lib/auth/            сессия (unknown | anonymous | authenticated, кэш в localStorage), вход/выход/401
src/lib/live/            WebSocket с переподключением (`socket.ts`), хуки `useLiveEvent`, `useConnectionState`
src/lib/nav/             пункты навигации, `useTitle`, восстановление прокрутки
src/lib/player/          плеер (не React): engine.ts (редьюсер, очередь), controller.ts (PlayerController), audio/ (контракт AudioEngine, web-engine на <audio>), media-session.ts, shortcuts.ts, hooks.ts (usePlayerState, useProgress)
src/lib/search/          поиск: useRemoteSearch (TanStack Query), история запросов, добавление в библиотеку, элементы палитры
src/sw/                  service worker: sw.ts (precache, fetch), classify.ts и cache.ts — чистые функции, тестируются без воркера
src/lib/pwa/             регистрация и обновления (update.ts), постоянное хранилище (storage.ts), установка (install.ts), onLogout (logout.ts)
src/lib/offline/         офлайн-треки (шаг 46): manager.ts (закрепления, сверка, очередь, повторы, место), storage/downloader за интерфейсами (types.ts), OPFS + воркер скачивания, playback.ts (источник для плеера), status.ts (store и селекторы), settings.ts
src/lib/theme/           light | dark | system, localStorage['nimbus:theme']
src/test/                setup, renderWithProviders, фабрики
tests/e2e/               Playwright; tests/mock-backend.ts — мок бэкенда (bun): вход, синхронизация, WebSocket, служебные `/__test/{reset,emit,mutate,ws,log,search,player,…}`; поток `GET /api/tracks/{id}/stream` отдаёт 5-секундный WAV (Range, `transcode` с `?t=`, управляемые ошибки), есть `played`, `prefetch`, `audio-info`, `GET /api/settings`; `GET /api/search` отдаёт `tests/fixtures/search-radiohead.json`, `POST /api/library` создаёт сущности из неё
```

## Соглашения

- Алиас `@/` → `src/`. Тексты — только через `useT()` и словари; новый ключ — во **все** языки.
- Адреса бэкенда — только через `@/lib/platform/urls`; литерал `'/api/…'` вне `lib/platform` и `lib/api` запрещён линтом.
- Сеть из `src/screens` и `src/components` — только через `src/lib/**` (линт запрещает `fetch` и импорт `@/lib/api/client`).
- Инструменты запускаются под Node (vitest, playwright, eslint — через `bun run`), сборка и установка — bun.
- Добавить экран: запись в `src/app-routes.tsx` (+ пункт в `NAV_ITEMS`, если он в навигации). Оболочку, защиту маршрутов и 404 трогать не нужно.
- e2e идут по одному (`workers: 1`): мок бэкенда общий, каждый тест начинает с `resetMock()`.

## PWA и офлайн

- **Сборка.** `vite-plugin-pwa` в режиме `injectManifest`: исходник `src/sw/sw.ts` (отдельный `tsconfig.sw.json`, `lib: webworker`),
  на выходе `dist/sw.js` (iife) и `dist/manifest.webmanifest`. В `bun run dev` service worker выключен; e2e идут против сборки.
- **Что кэшируется.** Precache: `index.html`, чанки, шрифты, иконки, словарь `en` (в основном бандле). Остальные словари — runtime-кэш
  `nimbus-runtime-v1` (stale-while-revalidate; после активации воркера `lib/pwa/warm.ts` дописывает уже загруженный словарь).
  Обложки (Cover Art Archive, archive.org) и фото артистов — cache-first в `nimbus-images-v2`, до 5000 записей, 404 не пишется.
  Навигация (кроме `/api/`) отвечается `index.html` из precache. `/api/` (включая поток аудио), WebSocket и запросы с `Range` воркер не трогает.
- **Обновления.** `registerType: 'prompt'`: новая версия ждёт; toast «Доступна новая версия» → «Обновить» (`SKIP_WAITING` + перезагрузка).
  Проверки — при старте, при возврате вкладки и раз в час. Перезагрузка никогда не происходит сама (в том числе во время музыки).
  Версия сборки — `__APP_VERSION__` (`package.json` + git-хэш; `APP_VERSION=… vite build` переопределяет).
- **Связь.** `useNetworkStatus()` → `online | offline | server-down`; `useOnline()` — `true` только при `online`; `<OfflineNotice />` — пояснение.
- **Выход.** `onLogout(handler)` (`lib/pwa/logout.ts`) — точка расширения; очищает кэш картинок и офлайн-треки (`clearOffline()`).
- **Как проверять офлайн.** `bun run build && bun run preview`, открыть приложение, дождаться синхронизации, затем DevTools → Network → Offline
  (или `context.setOffline(true)` в Playwright) и перезагрузить. Сброс: DevTools → Application → Storage → «Clear site data»
  (или Service Workers → Unregister + Cache Storage → удалить). e2e обновления: `tests/e2e/variants.ts` строит варианты `dist/` с другой версией.

## Офлайн-треки (движок, шаг 46)

- **Где лежит.** Файлы — в OPFS: `tracks/<trackId>` (без расширения), метаданные — в IndexedDB `nimbus` v2 (`offline_pins`, `offline_files`).
  Пишет выделенный воркер (`download.worker.ts`, `createSyncAccessHandle`; чанк воркера попадает в precache), читает основной поток.
- **Платформенная граница.** Менеджер общий для всех платформ; от платформы зависят только `OfflineStorage` и `Downloader`
  (`lib/offline/types.ts`). В PWA — OPFS и воркер; в нативных оболочках шаг 54 подставит файловую систему приложения и
  фоновые загрузки ОС. OPFS и `navigator.storage` вне `opfs-storage.ts` и воркера запрещены.
- **Закрепления** (`pin/unpin(kind, id)`: трек, альбом, плейлист) → нужный набор треков вычисляется из закреплений и библиотеки;
  файлы приводятся к нему автоматически (дельта библиотеки, debounce 1 с). Закрепление на удалённую сущность снимается.
- **Очередь.** До `concurrency` загрузок (1…6, по умолчанию 3), порядок — по времени закрепления, затем по номеру в альбоме.
  Берутся только `found|ready`, остальные ждут в `queued`. Повторы: 5 с → 30 с → 2 мин → 10 мин → 1 ч, докачка с места обрыва
  (`Range` + `If-Range`, если сервер отдал `Accept-Ranges` и `ETag`); после 8 попыток — `failed` (ручной `retry`).
  Очередь стоит: нет связи, пауза, «только Wi-Fi» по сотовой сети, лимит места, 401 (`status.blocked`).
- **Воспроизведение.** `resolveStreamUrl` отдаёт скачанный трек из файла (объектный URL, режим `direct` всегда); источник текущего
  и следующего треков готовится заранее (`prepare`) и отзывается при смене (`storage.release`). `canPlay` = скачан **или**
  (есть связь и `found|ready`). Файл не воспроизвёлся → запись возвращается в очередь, трек играет по сети.
- **Вкладки.** Скачивает лидер (Web Lock `nimbus-offline`); остальные получают состояние по `BroadcastChannel('nimbus-offline')`
  и могут вызывать `pin/unpin` (запись в IndexedDB + сообщение лидеру).
- **Настройки устройства:** `localStorage['nimbus:offline-settings']` — `limitBytes` (по умолчанию 50 % квоты, не более 20 ГБ),
  `concurrency`, `wifiOnly`. Состояние для интерфейса (шаг 47) — store `offline().status` и селекторы `trackOfflineState`,
  `albumOfflineState`, `playlistOfflineState`; `status.supported === false`, если нет OPFS (интерфейс скрывается).
- **e2e.** В e2e-сборке (`VITE_UI_GALLERY=1`) и dev есть `window.__nimbus.offline` (`pin/unpin/retry/setPaused/removeAll/state`).
