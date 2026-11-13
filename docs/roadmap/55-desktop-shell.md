# Шаг 55 — Настольная оболочка (Tauri 2): macOS, Windows, Linux

**Фаза 4 · Зависит от:** 52 (может выполняться независимо от 53–54)

## Зачем

PWA на desktop уже хороша; оболочка добавляет то, чего не даёт браузер: системные «Сейчас играет» и
медиаклавиши без открытой вкладки, иконку в трее, автозапуск, нативное меню, офлайн-файлы в обычной
папке без квоты браузера. Клиент тот же; Tauri — потому что бэкенд уже на Rust и сборка лёгкая.

## Текущее состояние

- `client/` с платформенным слоем, `AudioEngine`, `OfflineStorage`/`Downloader` (шаги 36, 41, 46); нативоподобный режим e2e, адрес сервера, Bearer, подписанные ссылки на поток (шаг 52).
- Webview: macOS — WKWebView, Windows — WebView2 (Chromium), Linux — WebKitGTK.

## Что сделать

1. **Проект `desktop/`**: Tauri 2 (последний стабильный), `src-tauri/` — Rust-крейт вне workspace бэкенда (отдельный `Cargo.toml`, но те же правила `docs/DEVELOPMENT.md` §3: fmt, clippy `-D warnings`, тесты); фронтенд — `../client/dist` (сборка `--mode native`), `platform() === 'desktop'` определяется по `window.__TAURI_INTERNALS__`.
   Окно: запоминание размера и положения, минимальный размер 360×600, тёмная/светлая рамка по теме; один экземпляр (`single-instance`: второй запуск показывает окно).
   Рецепты: `just desktop` (dev), `just desktop-build` (пакет для текущей ОС).
2. **Звук.** Остаётся `web-engine` (`<audio>` в webview), но поток — по подписанной ссылке шага 52 (`capabilities.headers = false`). Обёртка `desktop-engine.ts` = `web-engine` + системная интеграция:
   - Rust-команды на крейте `souvlaki`: MPRIS (Linux), System Media Transport Controls (Windows), `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` (macOS) — метаданные, обложка, позиция, состояние; команды системы → события `remote`.
   - Media Session в webview при этом отключается (иначе на macOS и Windows будут две записи «Сейчас играет»).
   - Linux: проверить воспроизведение FLAC/MP3/AAC/Opus в WebKitGTK (GStreamer); зависимости пакета `.deb` (`gstreamer1.0-plugins-good`, `-bad`, `gstreamer1.0-libav`) и предупреждение в README для AppImage.
3. **Офлайн-файлы.** `desktop-storage.ts`/`desktop-downloader.ts` поверх Rust-команд: каталог данных приложения (`app_data_dir()/tracks`, путь показывается в настройках, кнопка «Открыть папку»), загрузка — `reqwest` с `Range`/`If-Range` и докачкой (та же логика, что `downloadTo` шага 46; события — через Tauri events), `background = true` пока процесс жив (в т. ч. окно закрыто в трей); `usage.quota` — свободное место на диске.
   Источник для плеера — `convertFileSrc` (протокол `asset:` с поддержкой `Range` — проверь перемотку; если нет — собственный протокол `nimbus-file://` через `register_uri_scheme_protocol` с `Range`). Права `asset` ограничены каталогом `tracks`.
4. **Трей и меню.** Трей: текущий трек, play/pause, следующий, предыдущий, «Показать», «Выход». Настройки (раздел «Приложение», только на desktop): «Сворачивать в трей при закрытии» (по умолчанию — да на Windows/Linux, нет на macOS), «Запускать при входе в систему» (`autostart`). macOS: строка меню (Nimbus, Правка, Воспроизведение с горячими клавишами ⌘→/⌘←/пробел, Окно, Справка).
   Глобальные медиаклавиши — через системные медиаконтролы п. 2 (не `global-shortcut`, чтобы не перехватывать клавиши у других плееров).
5. **Безопасность.** CSP: `connect-src` — адрес сервера пользователя (задаётся во время выполнения → `connect-src https: http://localhost:* ws: wss:` и проверка в клиенте), `media-src 'self' asset: https: http:`; capabilities Tauri — минимальный набор команд; `dangerousRemoteDomainIpcAccess` не используется.
6. **Сборка и CI.** Задание `desktop` — матрица `ubuntu-22.04`, `windows-latest`, `macos-latest`: `cargo fmt --check`, `clippy`, `cargo test` для `src-tauri`, `tauri build` без подписи (артефакты `.deb`/`.AppImage`, `.msi`, `.dmg`). Подпись, нотаризация и автообновление — не в этом шаге.

## Тесты (обязательные)

- Rust (`src-tauri`): загрузчик — полный файл, докачка (206), сервер проигнорировал `Range` (200), 416, обрыв, несовпадение размера (на локальном тестовом HTTP-сервере); протокол файлов — `Range`-ответы; преобразование команд медиаконтролов в события. Покрытие крейта ≥ 80 % строк.
- Клиент (Vitest): `desktop-engine` (Media Session выключена, метаданные уходят в Rust-команду, команды системы → `remote`), `desktop-storage`/`desktop-downloader` с фейковым `invoke`, раздел настроек «Приложение» виден только на desktop.
- Smoke (Linux в CI, `tauri-driver` + WebDriver): запуск → экран «Сервер» → мок-бэкенд → вход → запуск трека → позиция растёт.

## Критерии приёмки

```
just client-check && just client-test && just client-cov && just client-e2e-native
(cd desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test)
just desktop-build
```

Ручные проверки (чек-лист устройств, колонки macOS/Windows/Linux-приложение): медиаклавиши и системный виджет «Сейчас играет», трей, автозапуск, офлайн после перезапуска. Если системных зависимостей Tauri нет в среде — `БЛОК:` со списком команд.

## Не входит в шаг

- Подпись кода, нотаризация macOS, автообновление, публикация — `docs/backlog.md`.
- Нативный (не webview) аудиодвижок на desktop: `<audio>` в webview достаточно; gapless на desktop — backlog.

## Подводные камни

- WebKitGTK отличается от Safari и Chromium: прогони матрицу скриншотов шага 49 (360/1440) в оболочке на Linux хотя бы вручную; известные проблемы — отрисовка `backdrop-filter`, View Transitions (нет — должен сработать запасной путь шага 50).
- На Windows origin — `http://tauri.localhost`: он должен быть в `NIMBUS_ALLOWED_ORIGINS` (по умолчанию есть, шаг 52).
- Подписанная ссылка истекает через 12 ч — пауза на ночь и «Продолжить» утром должны запросить новую (обработка 401 у `<audio>` → обновить ссылку и продолжить с позиции, тест обязателен).
- Закрытие в трей на macOS непривычно — отсюда другое значение по умолчанию.
