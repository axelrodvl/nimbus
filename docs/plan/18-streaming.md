# Шаг 18 — Стриминг с Range и статус ready

**Зависит от:** 17
**Оценка:** 2 дня

## Цель

`GET /api/tracks/{id}/stream` — отдаёт аудиофайл трека браузерному `<audio>` с поддержкой HTTP Range. Если файл не скачан — ставит в librqbit на скачивание **только этот файл** и стримит его по мере получения кусков (приоритет — текущая позиция чтения). По завершении скачивания трек становится `ready`.

## Что сделать

### 1. Выбор источника

1. Трек в статусе `found` или `ready`, иначе `409 {"code":"track_not_playable"}`.
2. Источник: primary из `track_sources`; если у primary есть `cue_start_ms` — это шаг 21 (пока `501 cue_not_supported`).
3. Есть запись `downloads` с `completed_at` и файл существует на диске → **отдать с диска** (п. 3). Иначе — через движок (п. 4).

### 2. Content-Type по расширению

`flac → audio/flac`, `mp3 → audio/mpeg`, `m4a/aac/alac → audio/mp4`, `ogg → audio/ogg`, `opus → audio/ogg` (или `audio/opus`), `wav → audio/wav`. Для `ape, wv, dsf, dff, aiff` → `415 {"code":"transcode_required"}` (шаг 21 добавит перекодирование).

### 3. Отдача с диска

`tower_http::services::ServeFile` (поддерживает Range, `If-Range`, ETag) — или собственная реализация через тот же код, что в п. 4. Обновить `downloads.last_played_at`.

### 4. Отдача через движок (основное)

1. `engine.ensure_file(magnet, file_index)` → handle; upsert `downloads(torrent_id, file_index, local_path = engine.file_path(...), bytes_total = size)`.
2. Разбор `Range` (поддержать `bytes=N-`, `bytes=N-M`, `bytes=-S`; несколько диапазонов → игнорировать, отдать первый; некорректный → `416` с `Content-Range: bytes */size`).
3. `engine.open_stream(handle, file_index)` → `seek(start)` → ограничить чтение длиной диапазона (`tokio::io::AsyncReadExt::take`) → `ReaderStream` с буфером 64 КБ → `Body::from_stream`.
4. Ответ: `206 Partial Content` (или `200`, если Range не было), заголовки `Accept-Ranges: bytes`, `Content-Range: bytes start-end/size`, `Content-Length`, `Content-Type`, `Cache-Control: no-store`.
   Образец — HTTP API rqbit (`crates/librqbit/src/http_api.rs`, обработчик stream) — переиспользуй подход.
5. Браузер часто открывает несколько запросов (начало файла, конец файла для метаданных/длительности, потом снова начало) и закрывает их при перемотке. Убедиться, что закрытие соединения освобождает поток (drop), а движок переключает приоритет на новую позицию.
6. **Время до первого байта:** если первый кусок не пришёл за 60 с — оборвать ответ (`504` если заголовки ещё не отправлены). Заголовки отправляются сразу, поэтому реально: держать запрос, пока не придут первые байты, с таймаутом; при таймауте — `504 {"code":"no_peers"}`.

### 5. Прогресс и ready

- Фоновая задача-наблюдатель (одна на процесс, tokio task): раз в 1 с для всех активных `downloads` без `completed_at` — `engine.file_progress` → публиковать `Event::StreamProgress` (только для файлов, которые сейчас стримятся или менялись), обновлять `bytes_done` в БД не чаще раза в 10 с.
- При `finished` → `downloads.completed_at = now()`, все треки с primary-источником на этот `(torrent_id, file_index)` → `ready` (+ событие `track.status`).
- При старте процесса — пройти по `downloads` с `completed_at` и проверить существование файлов; отсутствующие → сбросить `completed_at`, треки `ready → found`.

### 6. Отказоустойчивость источника

Если `ensure_file`/первый байт не удались (нет пиров) и у трека есть другие источники — **для следующего запроса** переключить primary на следующий по `match_score` (и залогировать). Автоматический переход внутри одного HTTP-ответа не делать.

### 7. HEAD

`HEAD /api/tracks/{id}/stream` — те же заголовки без тела (некоторые браузеры/плееры используют).

## Тесты

- Unit: парсер Range (все формы, некорректные, выход за размер).
- Интеграционный с фейковым движком (trait над `TorrentEngine` с реализацией поверх файла на диске, искусственно отдающей данные медленно): `206` с правильными `Content-Range`/`Content-Length`, байты совпадают; `Range: bytes=-1000` → последние 1000 байт; трек `adding` → `409`; `ape` → `415`.
- Наблюдатель: `finished` → `downloads.completed_at`, трек `ready`, событие опубликовано.
- (Если в шаге 15 есть локальный рой) сквозной тест: трек → stream → байты совпадают с исходным файлом, после завершения → `ready`, повторный запрос идёт с диска.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- Ручная проверка (при наличии сети): трек в статусе `found` → `curl -s -D - -o /tmp/t.flac -H 'Range: bytes=0-' localhost:8080/api/tracks/<id>/stream` — `206`, данные идут; `ffprobe /tmp/t.flac` распознаёт файл. Открыть URL в браузере — играет, перемотка работает.

## Вне рамок шага

UI плеера (шаг 19), CUE и перекодирование (шаг 21), prefetch и вытеснение кэша (шаг 22).
