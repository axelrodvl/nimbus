# Шаг 21 — CUE-образы и перекодирование ffmpeg

**Зависит от:** 18
**Оценка:** 2 дня

## Цель

1. Поддержать раздачи «образ + CUE» (один FLAC/APE/WV на весь альбом): сопоставить треки по CUE и проигрывать отрезок образа.
2. Поддержать форматы, которые браузер не играет (APE, WavPack, DSD, AIFF, иногда ALAC): перекодировать на лету через `ffmpeg`.

## Требования к окружению

`ffmpeg` в PATH (уже есть в Dockerfile шага 03; локально — `apt install ffmpeg`). При старте бэкенда проверить `ffmpeg -version`; если нет — логировать warning, эндпоинты перекодирования отвечают `503 ffmpeg_missing`.

## Что сделать

### 1. Обработка `cue_candidates` (бэкенд)

Новая задача `Job::ProcessCue { torrent_id, album_id, cue_file_index }` — ставится в шаге 17 при записи `cue_candidates` (допиши постановку в verify-handler). Обработчик:
1. `engine.ensure_file(magnet, cue_file_index)` — CUE весит килобайты, качается быстро; дождаться `finished` (таймаут 2 мин, иначе `Retry`).
2. Прочитать файл → `matcher::cue::parse_cue` → `match_cue(sheet, album_input)`.
3. Сопоставить `CueFile.name` с `image_file_index` (по имени файла в торренте; если в CUE один FILE, а образ один — сопоставить напрямую).
4. Для каждого сопоставленного трека: `track_sources::insert(track_id, torrent_id, image_file_index, score, cue_start_ms, cue_end_ms)`; primary — если у трека нет primary. Треки → `found`, события.
5. `cue_candidates.processed = true`; `release_file(cue)` не нужен (маленький).
6. Финализацию альбома (шаг 17, п. 3) выполнять **после** обработки всех cue-кандидатов альбома: учесть активные `process_cue` задачи в проверке «нет активных задач».

### 2. Стриминг через ffmpeg

Режим включается, если у источника есть `cue_start_ms` **или** расширение в списке `ape, wv, dsf, dff, aiff, alac` (ALAC — опционально, Chrome и Safari его играют в `.m4a`; оставь настройкой `transcode_alac`, по умолчанию `false`).

`GET /api/tracks/{id}/stream?t=<секунды>` в режиме перекодирования:
1. Источник байтов — тот же поток движка (`open_stream`) или файл с диска; подавать в `ffmpeg` через stdin (`-i pipe:0`). Для **seek** в CUE-образе по stdin ffmpeg вынужден читать с начала — это медленно для торрента. Поэтому:
   - если файл уже скачан (`completed_at`) → `ffmpeg -ss <start> -i <path>`;
   - иначе → поднять **локальный HTTP-эндпоинт с Range** для сырого файла (`GET /api/internal/raw/{torrent_id}/{file_index}`, доступен только с 127.0.0.1, переиспользует код шага 18) и дать ffmpeg URL: `ffmpeg -ss <start> -i http://127.0.0.1:8080/api/internal/raw/...` — ffmpeg сам делает Range-запросы и seek по FLAC/APE, движок приоритизирует нужные куски.
2. Команда (выход — FLAC без потерь для lossless-источников, Opus 192k для lossy или по настройке):
   ```
   ffmpeg -hide_banner -loglevel error -ss <cue_start + t> [-to <cue_end>] -i <input>
          -map 0:a:0 -vn -c:a flac -f flac pipe:1
   ```
   (`-to` при `-ss` перед `-i` трактуется относительно начала входа — проверь и при необходимости используй `-t <duration>`.)
3. Ответ — `200`, `Content-Type: audio/flac` (или `audio/ogg`), **без** `Accept-Ranges` (`Accept-Ranges: none`), `Transfer-Encoding: chunked`. Добавить заголовок `X-Nimbus-Duration-Ms` (длительность трека из БД или из CUE), чтобы фронт знал длительность.
4. Процесс `ffmpeg` убивать, когда клиент закрыл соединение (`kill_on_drop(true)` у `tokio::process::Command`). Лимит одновременных процессов — 4.
5. `HEAD` в этом режиме — `200` с `Content-Type` и `X-Nimbus-Transcode: 1`.

Убрать ответы `501 cue_not_supported` и `415 transcode_required` из шага 18 (теперь эти случаи поддерживаются).

### 3. Статус `ready` для CUE-треков

`ready` — когда скачан файл-образ целиком (наблюдатель шага 18 уже переводит в `ready` все треки с primary на этот файл — проверить, что работает и для CUE-источников).

### 4. Фронтенд

- Определение режима: `HEAD` перед воспроизведением (или поле `transcode: bool` в `TrackDto` — **предпочтительно**: добавь в бэкенде вычисляемое поле `playback: "direct" | "transcode"` в `TrackDto`, обнови OpenAPI/типы).
- Для `transcode`: перемотка — не через `audio.currentTime`, а через смену `src` на `...stream?t=<sec>` с локальным смещением отображаемой позиции (`position = offset + audio.currentTime`); длительность — из `duration_ms` / `X-Nimbus-Duration-Ms`; полоска буфера не показывается.
- Инкапсулировать это в движке плеера (шаг 19), потребители не меняются.

## Тесты

- Бэкенд: `ProcessCue` с фейковым движком и фикстурой CUE (cp1251) → источники с правильными `cue_start_ms/cue_end_ms`, треки `found`; финализация альбома ждёт `process_cue`.
- Интеграция ffmpeg (пропускать, если ffmpeg нет): сгенерировать `ffmpeg -f lavfi -i sine=d=30 image.flac` + CUE на 3 трека по 10 с → стрим второго трека → `ffprobe` длительность ≈ 10 с; `?t=5` → ≈ 5 с. Перекодирование `.wv` (сгенерировать `-c:a wavpack`) → корректный FLAC.
- Закрытие соединения убивает процесс ffmpeg (проверить, что дочерних процессов не осталось).
- Фронтенд (Playwright с моками): трек с `playback: "transcode"` — перемотка меняет `src` на `?t=`.

## Критерии приёмки

- `just test`, `just check`, `pnpm build` проходят; ffmpeg-тесты проходят при наличии ffmpeg (иначе отмечены в Журнале).
- Ручная проверка: альбом из раздачи «образ + CUE» играет по трекам, перемотка работает.

## Вне рамок шага

Настройки форматов из UI (шаг 22).
