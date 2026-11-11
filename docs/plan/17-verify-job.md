# Шаг 17 — Задача верификации раздачи (verify)

**Зависит от:** 14, 15, 16
**Оценка:** 1.5 дня

## Цель

Реальный обработчик `VerifyTorrent { torrent_id, album_id }`: получить список файлов раздачи (через движок или из кэша `torrent_files`), сопоставить с треками альбома, записать `track_sources`, перевести треки в `found`; когда все кандидаты альбома проверены — оставшиеся `adding` → `not_found`.

## Что сделать

### 1. Получение файлов

1. Загрузить `torrent`. Если `meta_status = 'ok'` и есть `torrent_files` → использовать их (без сети).
2. Иначе: `meta_status = 'fetching'` → `engine.fetch_metadata(magnet)`:
   - успех → `torrents::replace_files` (с `ext` в нижнем регистре), `meta_status = 'ok'`, `fetched_at = now()`;
   - `MetadataTimeout` → `meta_attempts += 1`, `meta_status = 'timeout'`; если `meta_attempts < 3` → `JobError::Retry { after: 15 min * meta_attempts }`, иначе `meta_status = 'dead'` и перейти к п. 4 как «проверено, совпадений нет»;
   - `InvalidMagnet` / прочее → `meta_status = 'error'`, `meta_error`, считать проверенной.
3. Публиковать `JobProgress { album_id, stage: Verifying, done, total }`, где `total` = число `album_torrents` альбома, `done` = число `verified`.

### 2. Сопоставление

1. Треки альбома для сопоставления: все треки альбома в статусах `adding`, `not_found` **и** `found` (у найденных может появиться источник лучше — добавляем как дополнительный, primary не меняем).
2. `matcher::match_album(files, album_input, &MatchConfig::default())`.
3. Для каждого `MatchResult` — `track_sources::insert` (ON CONFLICT DO UPDATE score). Если у трека ещё нет primary и `!needs_confirmation` → сделать этот источник primary; если у трека primary нет, а есть только `needs_confirmation`-источники — **тоже** сделать лучший из них primary (иначе трек нельзя будет слушать), но оставить флаг, чтобы UI шага 20 показал «проверьте источник».
4. Треки, получившие primary и находящиеся в `adding`/`not_found` → `found` (+ событие `track.status`).
5. `cue_candidates` → сохранить для шага 21: пока просто залогировать и записать в `torrents.meta_error = 'cue_image'` **не надо** — вместо этого добавь таблицу через миграцию `0003_cue_candidates.sql`:
   ```sql
   CREATE TABLE cue_candidates (
       torrent_id BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
       album_id   BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
       cue_file_index   INT NOT NULL,
       image_file_index INT NOT NULL,
       processed  BOOLEAN NOT NULL DEFAULT FALSE,
       PRIMARY KEY (torrent_id, album_id, cue_file_index)
   );
   ```
   Шаг 21 их обработает.

### 3. Завершение по альбому

1. `album_torrents::mark_verified(album_id, torrent_id)`.
2. Если `count_unverified(album_id) == 0` и **нет** активных `verify_torrent`/`discover_album` задач для альбома (проверить по `jobs.dedup_key`):
   - треки альбома, оставшиеся в `adding` → `not_found` c причиной:
     - `dead_torrents` — если все раздачи альбома `timeout/dead/error`;
     - `no_match` — иначе;
   - события `track.status` по каждому.
3. Гонки: две параллельные verify-задачи одного альбома могут одновременно решить «я последняя». Сделать п. 2 в транзакции с `SELECT ... FROM albums WHERE id=$1 FOR UPDATE`.

### 4. Порядок проверки

Верифицировать в порядке `rank_score` (задачи ставит шаг 14; дай `run_after` с небольшим смещением по рангу: лучший — сразу, остальные — +0..+N секунд). **Оптимизация:** если после очередной верификации все треки альбома, которые `in_library`, уже `found`, — оставшиеся непроверенные кандидаты всё равно проверяются (дадут резервные источники), но с низким приоритетом (`run_after + 10 min`), а статусы уже не ждут их.

### 5. Debug-эндпоинт

`GET /api/debug/albums/{id}/torrents` → раздачи альбома с `meta_status`, числом файлов и найденных треков. Пригодится в шаге 20 как основа публичного API.

## Тесты (`#[sqlx::test]` + фейковый движок)

Сделай trait `MetadataFetcher` (реализуется `TorrentEngine` и фейком в тестах), чтобы handler не зависел от librqbit напрямую.
- Альбомная раздача → все треки `found`, по одному primary, события опубликованы.
- Таймаут → `Retry`; третий таймаут → `dead`; если это последняя раздача и ничего не найдено → треки `not_found` / `dead_torrents`.
- Раздача без нужных файлов → после последней — `not_found` / `no_match`.
- Повторная проверка раздачи с `meta_status='ok'` не вызывает fetcher.
- Две раздачи: вторая добавляет резервные источники, primary не меняется.
- CUE-образ → строка в `cue_candidates`, треки остаются `adding` → в итоге `not_found` (пока шаг 21 не сделан).

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- Сквозная ручная проверка (при наличии сети): добавить альбом через `POST /api/library` → через 1–3 минуты треки в `GET /api/albums/{id}` переходят в `found` (или `not_found` с причиной); WS-клиент видит события.

## Вне рамок шага

Стриминг (шаг 18), обработка CUE (шаг 21).
