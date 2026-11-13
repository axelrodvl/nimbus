# Шаг 31 — Стриминг: таймауты простоя, секрет внутреннего эндпоинта, супервизор

**Фаза 1 · Зависит от:** 27, 28 · **Закрывает находки:** S1, S2, S3

## Зачем

Стрим — то, что пользователь слышит. Он не должен зависать навсегда, если пиры пропали посреди трека,
не должен открывать сырые файлы наружу и не должен молча перестать обновлять прогресс, если фоновая
задача упала. Шаг также добивает покрытие `stream.rs`/`transcode.rs`/`audio_info.rs` до цели.

## Текущее состояние (прочитай целиком)

- `backend/crates/api/src/stream.rs` (828 строк):
  - `stream_track` → `serve_file` (прямая отдача с Range) или `transcode::transcode_response`;
  - `raw_file` (`/api/internal/raw/{torrent_id}/{file_index}`) — доступ только по проверке `ConnectInfo … is_loopback()`; если `ConnectInfo` отсутствует — проверка пропускается;
  - `body_from` — таймаут `first_byte_timeout` (60 с) только на первый кусок, дальше `ReaderStream` без таймаута;
  - `failover` — при отсутствии пиров переключает primary на следующий источник;
  - `Watcher::tick` + `spawn_watcher` (раз в секунду; на каждую активную загрузку — запросы в БД), `reconcile_downloads`.
- `backend/crates/api/src/transcode.rs` — `Transcoder` (ffmpeg, `MAX_PROCESSES = 4`, `with_raw_base`), `transcode_response`, `resolve_input` (ffmpeg читает вход по HTTP с `/api/internal/raw/...`).
- `backend/crates/api/src/audio_info.rs` — сведения о формате через ffmpeg/ffprobe.
- `backend/crates/api/src/state.rs` — `AppState` (`first_byte_timeout`, `files`, `transcoder`, `activity`).
- Тесты: `crates/api/tests/stream.rs` (37 тестов), фейковый `FileProvider` в `tests/common`.

## Что сделать

1. **Секрет внутреннего эндпоинта.** При старте процесса генерируется случайный токен (32 байта, hex) —
   поле `AppState.internal_token`. `Transcoder` добавляет его к URL входа (`?k=<token>`) или заголовком (`-headers` ffmpeg).
   `raw_file` требует совпадения токена (сравнение за постоянное время) **и** loopback (когда `ConnectInfo` есть);
   без токена — `403`. Токен не логируется (проверь `TraceLayer`: URI с query попадает в лог — используй заголовок `X-Nimbus-Internal`, а не query).
   Маршрут исключить из OpenAPI (он и сейчас не должен там быть — проверь).
2. **Таймаут простоя стрима.** Обернуть поток тела ответа (`ReaderStream` в `body_from`, stdout ffmpeg в `transcode_response`)
   в адаптер `IdleTimeout<S>`: если следующий кусок не пришёл за `stream_idle_timeout` (новое поле `AppState`, по умолчанию 45 с) —
   поток завершается ошибкой (соединение рвётся), в лог `warn` с `track_id`; для прямой отдачи вызвать `failover`.
   Клиент (плеер) при обрыве переподключается с `Range` — это уже поддержано.
3. **Отмена при уходе клиента.** Убедись (и закрепи тестом), что при закрытии соединения клиентом:
   поток чтения из движка дропается; `StreamGuard` активности снимается; процесс ffmpeg убит (`kill_on_drop(true)`), слот `MAX_PROCESSES` освобождён.
4. **Супервизор watcher.** `spawn_watcher` → функция, которая перезапускает цикл при панике `tick` (с паузой 1 с и логом `error`),
   завершается по `CancellationToken` (передаётся из `main.rs`; заменить `watcher.abort()` на отмену + ожидание).
5. **Watcher без N+1.** `Watcher::tick`: одним запросом получить активные загрузки вместе с `info_hash`
   (`downloads::list_active_with_hash`), а треки с primary-источником — одним запросом на весь набор
   `(torrent_id, file_index)`; кэш в `Watcher` сбрасывать при исчезновении загрузки. Поведение (события, переход в `ready`, запись прогресса раз в 10 с) не меняется.
6. **Ошибки хранилища.** `EngineError::Storage` (шаг 27) → `507 Insufficient Storage`, код `storage_error`; описать в OpenAPI для стрима и prefetch.
7. **Согласованность `completed_local_path`/`open_reader`.** Сейчас логика «файл на диске и нужного размера» продублирована — свести к одной функции. Файл есть в БД как завершённый, но на диске отсутствует/другого размера → сбросить `completed_at`, вернуть треки `ready → found` (как `reconcile_downloads`, но на лету) и идти через движок.
8. **Заголовки для кэширования клиентом.** Для завершённого локального файла отдавать `ETag` (hash от `info_hash:file_index:size`) и `Accept-Ranges`; `Cache-Control: no-store` заменить на `private, no-cache` (нужно шагу 46: service worker сам решает, что хранить). Для перекодируемых — `X-Nimbus-Duration-Ms` уже есть; добавить `X-Nimbus-Source-Size` не нужно.
9. **Полный файл для офлайна.** Параметр `GET /api/tracks/{id}/stream?download=1`: поведение то же, но
   (а) `Content-Disposition: attachment; filename="NN - Title.ext"` (имя — из трека, безопасные символы),
   (б) файл помечается в `activity` как защищённый от вытеснения до конца ответа (уже так для стрима — убедись),
   (в) таймаут простоя для такого запроса — 120 с. Описать в OpenAPI.

## Тесты (обязательные)

`crates/api/tests/stream.rs` (расширить существующий фейковый `FileProvider`: управляемые задержки/обрыв чтения):
- `raw_file`: без токена → 403; с неверным → 403; с верным → 200/206; токен отсутствует в ответах и OpenAPI;
- простой посреди стрима: фейковый reader отдаёт первый кусок и «зависает» → тело завершается ошибкой через `stream_idle_timeout` (в тесте 100 мс), вызван failover (primary сменился);
- обрыв клиента: дроп тела ответа → `activity` больше не защищает файл; для перекодирования — фейковый ffmpeg завершён, слот свободен (следующий запрос не получает `transcoder_busy`);
- Range: все формы (`a-b`, `a-`, `-n`, за пределами → 416, несколько диапазонов → игнор/200), `HEAD`, пустой файл;
- завершённый файл пропал с диска → стрим идёт через движок, `completed_at` сброшен, трек `found`;
- `?download=1` → `Content-Disposition`, корректное имя для кириллицы и спецсимволов;
- `ETag`/`If-None-Match` → 304 для завершённого файла;
- `storage_error` → 507.

Watcher:
- паника внутри `tick` (инъекция через фейковый `FileProvider`, паникующий в `file_progress`) → цикл продолжает работать, следующий тик выполняется;
- отмена токена → задача завершается;
- число SQL-запросов на тик не зависит от числа активных загрузок (оценка через счётчик в тесте или просто тест на корректность при 50 загрузках — выбери реализуемое).

Перекодирование (`crates/api/tests/transcode.rs`, новый): фейковый «ffmpeg» — shell-скрипт во временном каталоге
(`NIMBUS_FFMPEG`/`Transcoder::new(path)`), который пишет байты в stdout/зависает/падает:
- успех: заголовки `X-Nimbus-Transcode`, `X-Nimbus-Duration-Ms`, тело передано;
- ffmpeg не дал первый байт вовремя → 504; упал сразу → 502;
- пятый одновременный запрос → 503 `transcoder_busy`;
- параметр `t` попадает в аргументы (`ffmpeg_args`).

`audio_info.rs`: покрыть разбор вывода и ошибки (фейковый бинарник).

## Критерии приёмки

```
just db-up && just check && just test && just cov
cd backend && cargo llvm-cov -p nimbus-api --features test-fakes --summary-only   # stream.rs, transcode.rs ≥ 90 %
just openapi && just web-gen-api && just web-check
just e2e      # если доступен Docker: полный сценарий со старым фронтендом по-прежнему проходит
```

## Не входит в шаг

- Очередь скачивания альбомов (шаг 33). Клиентская офлайн-логика (шаги 46–47).

## Подводные камни

- Старый фронтенд (`web/`) использует `/api/tracks/{id}/stream` как `<audio src>` — заголовки и коды ответов для обычного запроса не должны измениться (кроме `Cache-Control`).
- ffmpeg как HTTP-клиент: заголовок передаётся опцией `-headers "X-Nimbus-Internal: …\r\n"` **до** `-i`. Проверь на фейке, что аргумент на месте.
- `IdleTimeout` должен сбрасывать таймер только при реальной отдаче куска, а не при `Poll::Pending`.
- Фейковый ffmpeg-скрипт: `#!/bin/sh`, права `0o755`; на CI нет гарантии `bash`.
