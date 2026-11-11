# Шаг 07 — API поиска + OpenAPI

**Зависит от:** 06
**Оценка:** 1 день

## Цель

Эндпоинт `GET /api/search`, отдающий артистов, альбомы и треки из MusicBrainz с пометкой «уже в библиотеке», и OpenAPI-спецификацию бэкенда (`utoipa`) для генерации TS-типов на фронте.

## Что сделать

### 1. OpenAPI

- Подключить `utoipa` (+ `utoipa-axum` при желании) к `api`. Все DTO — `#[derive(Serialize, ToSchema)]`, все хендлеры — `#[utoipa::path(...)]`.
- `GET /api/openapi.json` — спецификация.
- (По желанию) Swagger UI на `/api/docs` через `utoipa-swagger-ui` или `utoipa-scalar` — только в debug.
- Все последующие шаги **обязаны** регистрировать свои эндпоинты и DTO в OpenAPI.
- Дополнительно: бинарный флаг `nimbus --print-openapi` печатает спецификацию в stdout и выходит (для генерации типов без запуска БД). Для этого разбор CLI-аргументов делать до подключения к БД.

### 2. DTO поиска

```rust
#[derive(Serialize, ToSchema)]
pub struct SearchResponse {
    pub query: String,
    pub artists: Vec<ArtistResult>,
    pub albums: Vec<AlbumResult>,
    pub tracks: Vec<TrackResult>,
    pub errors: Vec<String>,          // если один из трёх запросов упал — остальные всё равно отдаём
}
pub struct ArtistResult { pub mbid: Uuid, pub name: String, pub disambiguation: Option<String>, pub country: Option<String>,
                          pub score: u8, pub library_id: Option<i64> }
pub struct AlbumResult  { pub mbid: Uuid, pub title: String, pub artist_mbid: Uuid, pub artist_name: String,
                          pub primary_type: Option<String>, pub secondary_types: Vec<String>, pub year: Option<i32>,
                          pub cover_url: String, pub score: u8, pub library_id: Option<i64> }
pub struct TrackResult  { pub mbid: Uuid, pub title: String, pub artist_mbid: Uuid, pub artist_name: String,
                          pub album_mbid: Option<Uuid>, pub album_title: Option<String>, pub duration_ms: Option<u32>,
                          pub cover_url: Option<String>, pub score: u8, pub library_id: Option<i64>,
                          pub status: Option<TrackStatus> }
```

`library_id` — `id` сущности в нашей БД, если она есть **и** `in_library = true` (для треков — по `mbid_recording`; если трек есть в нескольких альбомах, брать любой с `in_library`), иначе `null`. `status` трека — из БД, если в библиотеке.

### 3. Эндпоинт

`GET /api/search?q=<строка>&types=artist,album,track&limit=10`

- `q` обрезать, длина 1..200, иначе `400 {"error":{"code":"bad_query"}}`.
- `types` по умолчанию все три; `limit` 1..25, по умолчанию 8.
- Три запроса к MB выполнять конкурентно (`tokio::join!`) с приоритетом `Interactive`. Они всё равно сериализуются лимитером (~3 с на холодный запрос) — это ожидаемо; кэш делает повторные мгновенными.
- Таймаут на весь эндпоинт 12 с: что не успело — в `errors`, остальное отдаётся.
- Обогащение `library_id`/`status` — одним SQL-запросом на тип (`WHERE mbid = ANY($1)`).
- Сортировка внутри типа — по `score` MB (как пришло).

### 4. Экономия лимита (важно для UX)

- Если `q` короче 3 символов — искать только артистов.
- (По желанию) `GET /api/search/stream?q=` — SSE, отдающее `artists`, `albums`, `tracks` по мере готовности тремя событиями. Если реализуешь — опиши в Журнале, шаг 09 сможет использовать.

### 5. Генерация типов для фронта

- В корневой `justfile`:
  ```make
  openapi:
      cd backend && cargo run -q -p api --bin nimbus -- --print-openapi > ../web/openapi.json
  ```
- Файл `web/openapi.json` коммитится (шаг 08 сгенерирует из него `schema.d.ts`). Если `web/` ещё не импортирован (шаг 02 не сделан) — положить в `docs/openapi.json` и отметить в Журнале.

## Тесты

- `wiremock` вместо MB + `#[sqlx::test]`: `/api/search?q=radiohead` → 3 непустых списка; артист, заранее вставленный в БД с `in_library=true`, получает `library_id`.
- Падение одного из MB-запросов (500) → 200 с непустым `errors` и двумя заполненными списками.
- Валидация `q`, `limit`, `types`.
- `--print-openapi` выдаёт валидный JSON с путём `/api/search`.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- `curl 'localhost:8080/api/search?q=radiohead' | jq '.artists[0].name'` → `"Radiohead"` (при наличии сети).
- `curl localhost:8080/api/openapi.json | jq '.paths | keys'` содержит `/api/search`, `/api/health`.
- `just openapi` создаёт `web/openapi.json`.

## Вне рамок шага

Добавление в библиотеку (шаг 10).
