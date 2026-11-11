# Шаг 10 — Бэкенд: добавление в библиотеку и API библиотеки

**Зависит от:** 05, 07
**Оценка:** 1.5–2 дня

## Цель

`POST /api/library` — добавление артиста, альбома или трека по MBID: сохранить метаданные из MusicBrainz, создать треки в статусе `adding`, поставить задачи `discover_*`. Плюс эндпоинты чтения библиотеки, страниц артиста и альбома, удаления.

## Что сделать

### 1. Сервис `core`/`api::services::library`

Логика в отдельном модуле (не в хендлерах), чтобы её переиспользовали тесты и будущие шаги.

**`ensure_artist(mbid) -> Artist`** — если нет в БД: `mb.artist(mbid)` → `artists::upsert_by_mbid`.

**`ensure_album(rg_mbid) -> (Album, Vec<Track>)`** — если альбома нет или у него нет треков:
1. `mb.release_group(rg_mbid)` → `ensure_artist(artist_mbid)`;
2. `mb.pick_canonical_release(rg_mbid)` → `mb.release_tracklist(release)`;
3. в одной транзакции: `albums::upsert` (с `cover_url = cover_url(rg, 500)`, `mbid_release`), `tracks::upsert_by_mbid_track` для каждого трека (`artist_id` = артист альбома; статус по умолчанию `adding`).
Все MB-вызовы — с приоритетом `Background`, кроме случая, когда пользователь ждёт ответа (см. ниже).

**`add_album(rg_mbid)`** — `ensure_album`, `albums.in_library = true`, `added_at = now()`, все треки альбома `in_library = true`; артист альбома — `in_library = true` (чтобы он был в списке артистов библиотеки). Треки в статусе `not_found` → `adding`. Поставить `Job::DiscoverAlbum`.

**`add_track(recording_mbid, album_mbid: Option)`**:
1. если `album_mbid` не передан — `mb.search_recordings("rid:<mbid>")` (или lookup `/recording/{mbid}?inc=releases+release-groups`) и выбрать release group по правилу из шага 06;
2. `ensure_album(rg)` (альбом **не** помечается `in_library`);
3. найти в альбоме трек с этим `mbid_recording` (если нет — ошибка `422 recording_not_in_release`, либо создать трек вне треклиста — на твоё усмотрение, отметь в Журнале), `in_library = true`;
4. артист — `in_library = true`;
5. `Job::DiscoverAlbum` для альбома (раздачи ищутся по альбому — так больше шансов найти файл).

**`add_artist(mbid)`**:
1. `ensure_artist`, `in_library = true`;
2. ответить клиенту сразу (`202`), а остальное — в фоне: новая задача `Job::ImportArtist { artist_id }` (добавь вариант в `Job`), которая
   - `mb.artist_release_groups(mbid, ["album","ep"])`, отбрасывает группы с secondary types `Compilation`, `Live`, `Remix`, `DJ-mix`, `Demo` (список — константа, позже станет настройкой);
   - для каждой группы `add_album` **без** постановки `DiscoverAlbum` (публикуя `library.changed` по каждому альбому);
   - в конце — `Job::DiscoverArtist { artist_id }` (шаг 14 ищет дискографии, затем альбомы).
   Зарегистрировать handler `ImportArtist` в `WorkerPool` (concurrency 1).

**`remove(type, id)`** — снять `in_library` (сущности не удалять — метаданные и найденные источники пригодятся). Для артиста — снять со всех его альбомов и треков. Для альбома — со всех треков.

После каждого изменения публиковать `Event::LibraryChanged`.

### 2. Эндпоинты

```
POST   /api/library                 body: { type: "artist"|"album"|"track", mbid, album_mbid? }
         → 201 { type, id, status: "added" }        (album, track)
         → 202 { type, id, status: "importing" }    (artist)
         → 200 если уже в библиотеке
DELETE /api/library/{type}/{id}     → 204

GET /api/library/artists?cursor=&limit=50         → { items: ArtistDto[], next_cursor }
GET /api/library/albums?cursor=&limit=50          → { items: AlbumDto[], next_cursor }
GET /api/library/tracks?status=&cursor=&limit=100 → { items: TrackDto[], next_cursor }
GET /api/artists/{id}  → ArtistDetailDto { artist, albums: AlbumDto[] }   (альбомы, где хоть что-то в библиотеке)
GET /api/albums/{id}   → AlbumDetailDto  { album, artist, tracks: TrackDto[] }  (все треки альбома с флагом in_library)
GET /api/tracks/{id}   → TrackDto
```

DTO (всё в OpenAPI):
```rust
pub struct ArtistDto { pub id: i64, pub mbid: Uuid, pub name: String, pub disambiguation: Option<String>,
                       pub in_library: bool, pub album_count: i64, pub track_count: i64 }
pub struct AlbumDto  { pub id: i64, pub mbid: Uuid, pub title: String, pub artist_id: i64, pub artist_name: String,
                       pub year: Option<i32>, pub primary_type: Option<String>, pub cover_url: Option<String>,
                       pub in_library: bool, pub track_count: i64,
                       pub status_counts: StatusCounts }      // { adding, found, not_found, ready }
pub struct TrackDto  { pub id: i64, pub mbid_recording: Uuid, pub title: String,
                       pub album_id: i64, pub album_title: String, pub artist_id: i64, pub artist_name: String,
                       pub disc_no: i32, pub position: i32, pub duration_ms: Option<i32>,
                       pub cover_url: Option<String>, pub status: TrackStatus, pub status_reason: Option<String>,
                       pub in_library: bool }
```

Списки библиотеки — только `in_library = true`, сортировка по `added_at DESC, id DESC`. Треки в `AlbumDetailDto` — по `disc_no, position`.

### 3. Ошибки

- MBID не найден в MB → `404 mb_not_found`.
- MB недоступен → `503 mb_unavailable` (добавление трека/альбома синхронное, пользователь ждёт).
- Неверный `type` → `400`.

### 4. Обновить OpenAPI и `web/openapi.json` (`just openapi`)

## Тесты (`wiremock` для MB + `#[sqlx::test]`)

- `POST album` → альбом и N треков в БД, все `adding`, `in_library`; в `jobs` — одна `discover_album`. Повторный POST → 200, вторая задача не создаётся (dedup).
- `POST track` → альбом не в библиотеке, в библиотеке ровно один трек; `discover_album` поставлена.
- `POST artist` → 202; выполнить задачу `ImportArtist` вручную через handler → альбомы созданы без Compilation/Live, поставлена `discover_artist`.
- `DELETE album` → треки не в библиотеке, строки не удалены.
- `GET /api/albums/{id}` → `status_counts` корректны.
- Событие `library.changed` публикуется (подписаться на `EventBus` в тесте).

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят, `web/openapi.json` обновлён.
- С живым MB: `curl -XPOST localhost:8080/api/library -H 'content-type: application/json' -d '{"type":"album","mbid":"b1392450-e666-3926-a536-22c65f834433"}'` (OK Computer) → 201; `GET /api/albums/{id}` — 12 треков в статусе `adding`.

## Вне рамок шага

Поиск раздач (шаг 14) — задачи `discover_*` пока обрабатываются заглушками из шага 05.
