# Шаг 53 — Оболочка iOS и Android (Capacitor) и нативный плеер

**Фаза 4 · Зависит от:** 52

## Зачем

Тот же клиент из `client/dist`, упакованный в приложения для iPhone/iPad и Android, — и нативное
воспроизведение вместо `<audio>`: надёжный фон, экран блокировки и шторка, гарнитура, прерывания,
gapless. Интерфейс и логика не меняются: оболочка подставляет свою реализацию `AudioEngine`
(контракт шага 41), `SecretStore` и `haptics`.

## Текущее состояние

- `client/` — SPA с платформенным слоем (`src/lib/platform`), контрактом `AudioEngine` (`src/lib/player/audio`), нативоподобным режимом e2e (шаг 52).
- Бэкенд принимает Bearer, CORS для `capacitor://localhost` и `https://localhost`, WS-подпротокол, подписанные ссылки (шаг 52).
- Чек-лист устройств `docs/device-checklist.md` с колонкой «Ограничение платформы» (шаг 50).

## Что сделать

1. **Проект `mobile/`** (корень репозитория): `package.json` (bun), `capacitor.config.ts` (`appId: 'co.nimbus.app'` — уточни у владельца при выполнении; если не ответил — оставь и запиши в Журнал; `webDir: '../client/dist'`), каталоги `ios/` и `android/` (сгенерированы `cap add`, коммитятся), версии Capacitor — последние стабильные.
   Сборка клиента для оболочки: `bun run build -- --mode native` в `client/` (`platform()` определяется во время выполнения через `Capacitor.getPlatform()`, а не переменной сборки — один `dist` на обе платформы).
   Рецепты: `just mobile-sync` (сборка клиента + `cap sync`), `just mobile-android` (`./gradlew assembleDebug`), `just mobile-ios` (`xcodebuild` для симулятора, только macOS).
2. **Локальный плагин `mobile/plugins/nimbus-audio`** (TypeScript-определения + Swift + Kotlin), API — зеркало `AudioEngine` (контракт — `client/src/lib/player/audio/types.ts`; шаг 41 добавил к исходному описанию метод `unload()` — сброс источника без разрушения движка, `setVolume(v)` принимает 0–1 (mute — это громкость 0, отдельного `setMuted` нет), `load` синхронный, `AudioPosition.buffered` — массив пар секунд): `load`, `unload`, `play`, `pause`, `seek`, `setVolume`, `preloadNext`, `setNowPlaying`, `getPosition`, `isPlaying()` (шаг 50: фактическое состояние звука для сверки после возврата из фона), события `state`, `position` (4 раза в секунду, только пока приложение на переднем плане; в фоне — по запросу), `ended`, `advanced`, `error`, `remote`.
   - **iOS:** `AVQueuePlayer` (текущий + следующий элемент → gapless и переход в фоне без участия JS), `AVAudioSession` категории `.playback` (фоновый режим `audio` в `Info.plist`), `MPNowPlayingInfoCenter` (метаданные, обложка — загрузка по URL с заголовками, позиция, скорость), `MPRemoteCommandCenter` (play/pause/toggle/next/previous/changePlaybackPosition/skip ±15 с), прерывания (`AVAudioSession.interruptionNotification` → событие `{type:'paused', interrupted:true}` — флаг `interrupted?` в `AudioEvent` добавлен шагом 50, автопродолжение по флагу `shouldResume`), смена маршрута (наушники отключены → пауза), заголовки запроса через опции `AVURLAsset`.
   - **Android:** Media3 (`ExoPlayer` в `MediaSessionService`, уведомление и шторка — системные), аудиофокус и `ACTION_AUDIO_BECOMING_NOISY`, плейлист из двух элементов для gapless, `DefaultHttpDataSource` с заголовками, foreground service только во время игры.
   - Режим `transcode` (перемотка через `?t=`): плагин принимает новый источник со смещением отображаемой позиции (`load(src, { startAt, positionOffset })` — уже в контракте шага 41).
3. **`client/src/lib/player/audio/native-engine.ts`** — реализация `AudioEngine` поверх плагина; `capabilities = { gapless: true, nativeNowPlaying: true, backgroundSafe: true, headers: true }`. Фабрика `createAudioEngine()` выбирает её при `platform() ∈ {ios, android}`; Media Session и `<audio>` в этом режиме не создаются.
   Контроллер уже умеет событие `advanced` (шаг 41): после него очередь сдвигается, и `preloadNext` получает следующий трек.
4. **Секреты и вибрация.** `SecretStore` на Keychain (iOS) / EncryptedSharedPreferences (Android) — готовый плагин сообщества с проверенной поддержкой или маленький локальный; `haptics.ts` → `@capacitor/haptics` (лёгкий удар на долгое нажатие, выбор при перестановке).
5. **Оболочка.** `@capacitor/status-bar` (цвет и стиль по теме, контент под строкой состояния — безопасные зоны уже есть), `@capacitor/splash-screen` (скрыть после гидратации store, не по таймеру), иконки и заставки из `logo.svg` (`@capacitor/assets`), `@capacitor/keyboard` (режим `resize: native`, совместимость с п. 4 шага 50), `@capacitor/app`: кнопка «Назад» Android → `history.back()`, на корневом экране — свернуть приложение; `appStateChange` → `lifecycle.ts` шага 50.
   Жест «назад» от края (шаг 50) на iOS работает и здесь; на Android — системный.
   `WKWebView`: `allowsBackForwardNavigationGestures = false` (жест свой), отключить предпросмотр ссылок по долгому нажатию.
6. **Сеть.** На Android разрешить cleartext только для локальных адресов (`network_security_config`: `localhost`, `10.0.2.2`, частные подсети — по списку доменов нельзя, поэтому `cleartextTrafficPermitted` с предупреждением на экране «Сервер» при `http://`); на iOS — `NSAllowsLocalNetworking` + описание доступа к локальной сети.
7. **Чек-лист.** Дополнить `docs/device-checklist.md` колонками «iOS-приложение» и «Android-приложение» по тем же сценариям + gapless (альбом без пауз между треками), CarPlay/Android Auto — «не поддерживается (backlog)».

## Тесты (обязательные)

- Клиент (Vitest): `native-engine` с фейковым плагином — отображение всех событий в `AudioEvent`, `advanced` сдвигает очередь без повторного `load`, `remote` → действия контроллера, `positionOffset` для `transcode`; фабрика выбирает реализацию по платформе; `SecretStore`/`haptics` вызывают плагины.
- Android (JUnit, без устройства): логика очереди плагина (текущий/следующий, замена следующего, `advanced` при переходе), преобразование команд сессии в события.
- iOS (XCTest, только macOS): то же для `AVQueuePlayer`-обёртки.
- E2E клиента в режиме `native-like` (шаг 52) — зелёные: оболочка не должна ничего ломать в общем коде.

## Критерии приёмки

```
just client-check && just client-test && just client-cov && just client-build && just client-e2e-native
just mobile-sync && just mobile-android && (cd mobile/android && ./gradlew test)
just mobile-ios   # только на macOS
```

CI: задание `mobile-android` (ubuntu, JDK, Android SDK — `assembleDebug` + `test`); iOS-сборка — задание на `macos-latest` с ручным запуском.
Если Android SDK/Xcode недоступны в среде выполнения — выполнить клиентскую часть, оставить `[~]`, записать `БЛОК:` со списком команд для человека. Установка на устройство и прогон чек-листа — ручная проверка (в Журнал).

## Не входит в шаг

- Офлайн-файлы на устройстве — шаг 54 (до него в оболочке работает `OfflineStorage` OPFS из шага 46, если webview его поддерживает; иначе интерфейс офлайна скрыт флагом `supported`).
- CarPlay, Android Auto, виджеты, Siri/Ассистент — `docs/backlog.md` (CarPlay требует отдельного разрешения Apple).
- Публикация в App Store / Google Play, подпись релизных сборок.

## Подводные камни

- Первый запуск звука на iOS из нативного плеера не требует жеста — но сохрани синхронный путь из шага 41: тот же код работает в PWA.
- `AVQueuePlayer` удаляет сыгранные элементы сам: состояние очереди — у контроллера, плагин знает только «текущий + следующий». Не дублируй очередь в нативном коде.
- В фоне JS в WKWebView может быть приостановлен: всё, что должно происходить без JS (переход к следующему, экран блокировки), — в нативном коде; учёт прослушиваний досылается при возврате (outbox шага 37).
- Обложку для экрана блокировки загружает нативный код, а не webview: ему нужны заголовки авторизации или подписанная ссылка.
- `cap sync` перезаписывает `ios/App/App/public` — не держи там правок.
