# Шаг 06 — Клиент MusicBrainz

**Зависит от:** 04
**Оценка:** 1.5 дня

## Цель

Крейт `musicbrainz`: типизированный клиент MusicBrainz Web Service v2 с соблюдением лимитов, кэшем в `mb_cache`, склейкой одинаковых запросов и функциями, нужными шагам 07 и 10.

## Правила MusicBrainz (обязательно)

- Base URL: `https://musicbrainz.org/ws/2/`, всегда `fmt=json`.
- **Лимит: в среднем 1 запрос/сек с IP.** При превышении — `503`. Нужен глобальный лимитер на весь процесс.
- **Обязательный `User-Agent`** вида `Nimbus/0.1 ( contact-url )` — из `config.mb_user_agent`.
- Документация: https://musicbrainz.org/doc/MusicBrainz_API , поиск — https://musicbrainz.org/doc/MusicBrainz_API/Search

## Что сделать

### 1. Транспорт

```rust
pub struct MbClient {
    http: reqwest::Client,          // UA, timeout 15s, gzip
    base: Url,                      // переопределяется в тестах (wiremock)
    limiter: governor::DefaultDirectRateLimiter,  // 1 req / 1.1s, burst 1
    cache: Option<MbCache>,         // обёртка над db::repo::mb_cache
    inflight: Mutex<HashMap<String, Shared<BoxFuture<'static, Result<Arc<Value>, MbError>>>>>,
}
```

- `async fn get_json(&self, path: &str, query: &[(&str, &str)], ttl: Duration) -> Result<Value, MbError>`:
  1. ключ кэша = `path?sorted_query`;
  2. если есть в `mb_cache` и не истёк → вернуть;
  3. если такой же запрос уже в полёте → дождаться его (single-flight, `futures::future::Shared`);
  4. `limiter.until_ready().await` → запрос;
  5. `503`/`429` → подождать (`Retry-After` или 2 с) и повторить до 3 раз; `404` → `MbError::NotFound`;
  6. записать в кэш с TTL.
- TTL: поиск — 24 ч, lookup — 7 дней.
- **Приоритеты:** интерактивный поиск не должен ждать за длинной очередью фоновых lookup-ов (добавление артиста с 30 альбомами = 30+ запросов). Сделай две очереди: `Priority::Interactive` и `Priority::Background`; лимитер общий, но интерактивные запросы пропускаются вперёд (например, через `tokio::sync::Semaphore`/канал-планировщик, отдающий токен лимитера сначала интерактивным). Если сложно — минимум: фоновые запросы перед каждым вызовом уступают (`yield`), когда есть ожидающие интерактивные (счётчик `AtomicUsize`).

### 2. Экранирование Lucene

`fn lucene_escape(s: &str) -> String` — экранировать `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`. Пользовательский ввод подставлять как `"<escaped>"` или как набор термов. Для поиска «по мере ввода» хорошо работает: `query = <escaped terms>` без полей (MB ищет по основным полям) плюс к последнему терму `*` при длине ≥ 3.

### 3. Модели ответа (serde, только нужные поля, `#[serde(default)]` на опциональных)

Поиск:
- `/artist?query=…&limit=…` → `{ artists: [{ id, name, sort-name, disambiguation?, country?, type?, score, life-span? }] }`
- `/release-group?query=…` → `{ release-groups: [{ id, title, primary-type?, secondary-types?, first-release-date?, score, artist-credit: [{ name, artist: { id, name } }] }] }`
- `/recording?query=…` → `{ recordings: [{ id, title, length?, score, artist-credit, releases?: [{ id, title, status?, date?, release-group: { id, title, primary-type? } }] }] }`

Lookup / browse:
- `/artist/{mbid}` → базовые поля артиста.
- `/release-group/{mbid}?inc=artist-credits` → release group.
- `/release?release-group={mbid}&inc=media&status=official&limit=100` (browse) → `{ releases: [{ id, title, status, date?, country?, media: [{ format?, track-count }] }] }`.
- `/release/{mbid}?inc=recordings+artist-credits` → `{ id, title, date?, media: [{ position, format?, tracks: [{ id, number, position, title, length?, recording: { id, title, length? } }] }] }`.
- `/release-group?artist={mbid}&type=album|ep&limit=100&offset=N` (browse, пагинация до исчерпания `release-group-count`) → release groups артиста.

Публичные доменные структуры (то, что отдаём наружу, без MB-специфики):
```rust
pub struct ArtistHit { pub mbid: Uuid, pub name: String, pub disambiguation: Option<String>, pub country: Option<String>, pub score: u8 }
pub struct ReleaseGroupHit { pub mbid: Uuid, pub title: String, pub artist_mbid: Uuid, pub artist_name: String, pub primary_type: Option<String>, pub secondary_types: Vec<String>, pub year: Option<i32>, pub score: u8 }
pub struct RecordingHit { pub mbid: Uuid, pub title: String, pub artist_mbid: Uuid, pub artist_name: String, pub duration_ms: Option<u32>, pub release_group_mbid: Option<Uuid>, pub album_title: Option<String>, pub score: u8 }
pub struct ReleaseTracklist { pub release_mbid: Uuid, pub tracks: Vec<TrackItem> }
pub struct TrackItem { pub mbid_track: Uuid, pub mbid_recording: Uuid, pub title: String, pub disc_no: i32, pub position: i32, pub duration_ms: Option<u32> }
```
Первый `artist-credit` — основной артист. `year` — первые 4 символа даты.

Для `RecordingHit.release_group_mbid` выбирать релиз по приоритету: release group типа `Album` без secondary types (не Compilation/Live) > `EP` > `Single` > остальное; среди них — `status=Official`, самая ранняя дата.

### 4. Публичный API клиента

```rust
impl MbClient {
    pub async fn search_artists(&self, q: &str, limit: u8) -> Result<Vec<ArtistHit>>;
    pub async fn search_release_groups(&self, q: &str, limit: u8) -> Result<Vec<ReleaseGroupHit>>;
    pub async fn search_recordings(&self, q: &str, limit: u8) -> Result<Vec<RecordingHit>>;
    pub async fn artist(&self, mbid: Uuid) -> Result<ArtistHit>;
    pub async fn release_group(&self, mbid: Uuid) -> Result<ReleaseGroupHit>;
    pub async fn artist_release_groups(&self, artist: Uuid, types: &[&str]) -> Result<Vec<ReleaseGroupHit>>;
    pub async fn pick_canonical_release(&self, release_group: Uuid) -> Result<Uuid>;
    pub async fn release_tracklist(&self, release: Uuid) -> Result<ReleaseTracklist>;
}
pub fn cover_url(release_group: Uuid, size: u16) -> String // https://coverartarchive.org/release-group/{id}/front-{size}
```

### 5. Выбор каноничного релиза (`pick_canonical_release`)

Среди официальных релизов группы считать балл:
- формат носителей: все `Digital Media` +3, `CD` +2, `Vinyl`/прочее +0;
- страна: `XW` +2, `US`/`GB` +1;
- число треков равно **моде** по всем релизам +3 (отсекает deluxe/бонусные издания);
- самая ранняя дата среди равных — тай-брейк.
Если официальных нет — взять любой с максимальным баллом. Функция чистая на уровне выбора (`fn score_release(&ReleaseBrief, mode_track_count) -> i32`) — покрыть unit-тестами.

## Тесты

- Фикстуры: записать реальные JSON-ответы MB (по одному на каждый тип запроса; например, для «Radiohead», «OK Computer», «Paranoid Android») в `crates/musicbrainz/tests/fixtures/`. Если сети нет — составить вручную по документации MB.
- `wiremock`: парсинг всех ответов в доменные структуры; `503` → повтор → успех; одинаковые параллельные запросы → один HTTP-вызов (single-flight); второй вызов берётся из `mb_cache` (с `#[sqlx::test]`).
- Лимитер: 3 последовательных запроса занимают ≥ 2 с (для теста допускается сконфигурировать лимитер быстрее и проверить пропорцию).
- `lucene_escape`, `score_release`, выбор release group для recording — unit-тесты.
- Живой тест `#[ignore]`: `search_artists("radiohead")` возвращает артиста с mbid `a74b1b7f-71a5-4011-9441-d0b5e4122711`.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- `cargo test -p musicbrainz -- --ignored` проходит при наличии сети (если сети нет — отметить в Журнале, не блок).

## Вне рамок шага

HTTP-эндпоинты (шаг 07), сохранение в БД библиотеки (шаг 10).
