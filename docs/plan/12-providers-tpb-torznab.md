# Шаг 12 — Провайдеры торрентов: trait, TPB, Torznab

**Зависит от:** 04
**Оценка:** 1.5 дня

## Цель

Крейт `trackers`: общий интерфейс поиска раздач и две реализации — The Pirate Bay (через JSON-API apibay) и Torznab (Jackett/Prowlarr — даёт доступ к десяткам трекеров). RuTracker — шаг 13.

## Что сделать

### 1. Общие типы (`trackers::types`)

```rust
pub struct SearchQuery {
    pub text: String,              // уже собранная строка, например "Radiohead OK Computer"
    pub artist: Option<String>,    // для провайдеров с структурным поиском (Torznab t=music)
    pub album: Option<String>,
    pub year: Option<i32>,
}

pub struct TorrentCandidate {
    pub source: TorrentSource,     // из core
    pub source_topic_id: Option<String>,
    pub title: String,
    pub info_hash: Option<InfoHash>,   // None — если нужен отдельный шаг (rutracker)
    pub magnet: Option<String>,
    pub size_bytes: Option<u64>,
    pub seeders: Option<u32>,
    pub leechers: Option<u32>,
    pub category: Option<String>,
    pub files_count: Option<u32>,
}

#[async_trait]
pub trait TorrentProvider: Send + Sync {
    fn source(&self) -> TorrentSource;
    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError>;
    /// Дозаполнить info_hash/magnet, если search их не вернул. По умолчанию — no-op.
    async fn resolve(&self, c: TorrentCandidate) -> Result<TorrentCandidate, ProviderError> { Ok(c) }
}

pub enum ProviderError { Network(..), Blocked(String), Auth(String), Parse(String), RateLimited }
```

- `pub fn build_magnet(info_hash: &InfoHash, name: &str, trackers: &[&str]) -> String` — `magnet:?xt=urn:btih:<hash>&dn=<urlenc name>&tr=<urlenc>...`.
- Константа `PUBLIC_TRACKERS`:
  ```
  udp://tracker.opentrackr.org:1337/announce
  udp://open.stealth.si:80/announce
  udp://tracker.torrent.eu.org:451/announce
  udp://exodus.desync.com:6969/announce
  udp://open.demonii.com:1337/announce
  udp://tracker.openbittorrent.com:6969/announce
  ```
- `ProviderRegistry { providers: Vec<Arc<dyn TorrentProvider>> }` — создаётся из `Config` (TPB при `tpb_enabled`, Torznab при заданном `torznab_url`, RuTracker — шаг 13). Метод `search_all(&q) -> Vec<(TorrentSource, Result<Vec<Candidate>>)>` — параллельно, таймаут 20 с на провайдера.
- Простой лимитер на провайдера (`governor`, 1 запрос / 2 с), чтобы не забанили.

### 2. The Pirate Bay (`trackers::tpb`)

- `GET https://apibay.org/q.php?q=<urlencoded>&cat=100` (100 — Audio; 101 — Music, 104 — FLAC). Base URL настраиваемый (для тестов и зеркал).
- Ответ — JSON-массив:
  ```json
  [{"id":"123","name":"Radiohead - OK Computer (1997) [FLAC]","info_hash":"ABCDEF...","leechers":"3","seeders":"57",
    "num_files":"14","size":"512345678","username":"x","added":"1500000000","status":"vip","category":"104","imdb":""}]
  ```
  Все числа — **строками**. Пустой результат — массив из одного элемента с `"id":"0"` и `"name":"No results returned"` → вернуть пустой вектор.
- `info_hash` → нижний регистр; `magnet` = `build_magnet(hash, name, PUBLIC_TRACKERS)`; `category` — строкой кода; `files_count` — из `num_files`.
- Отбросить категории вне 100–199.

### 3. Torznab (`trackers::torznab`)

- `GET {url}/api?t=music&artist=<a>&album=<b>&apikey=<key>&extended=1`; если `artist`/`album` не заданы или Torznab вернул пусто — `t=search&q=<text>&cat=3000`.
- Ответ — RSS XML (`quick-xml` + serde). Элементы `<item>`: `<title>`, `<size>`, `<link>`, `<enclosure url=…>`, атрибуты `<torznab:attr name="seeders|peers|infohash|magneturl|category|files" value="…"/>`.
- `info_hash` — из `infohash`, иначе из `magneturl`; если нет ни того, ни другого (только `.torrent`-ссылка), кандидат сохраняется с `magnet = None` — `resolve` скачивает `.torrent` и считает info-hash (крейт `lava_torrent` или `librqbit-core`/`bencode` → SHA1 от bencoded `info`). Если реализовывать сложно — пропустить такие кандидаты и отметить в Журнале.
- `leechers` = `peers - seeders`.

### 4. Нормализация строк запросов

`trackers::query::build_queries(artist, album, year) -> Vec<SearchQuery>` (используется шагом 14):
1. `"{artist} {album}"`
2. `"{artist} {album} {year}"` (если год есть)
3. `"{artist} discography"`
4. `"{artist}"` (только для провайдеров с хорошим поиском — флаг)

Перед подстановкой: убрать из названия альбома скобочные суффиксы (`(Deluxe Edition)`, `[Remastered]`), заменить `&` на `and` во второй вариации, транслитерацию **не** делать (RuTracker хорошо ищет кириллицу).

## Тесты

- Фикстуры JSON/XML в `crates/trackers/tests/fixtures/` (реальные ответы, если есть сеть; иначе — составленные по описанию выше).
- `wiremock`: TPB — парсинг, «No results returned» → пусто, строки-числа; Torznab — парсинг attr, fallback на `t=search`.
- `build_magnet` — корректное URL-кодирование; `InfoHash` в нижнем регистре.
- `search_all`: один провайдер падает/таймаутит — остальные результаты возвращаются.
- Живые тесты `#[ignore]`: TPB `"Radiohead OK Computer"` → ≥ 1 результат.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- `cargo test -p trackers -- --ignored` (при наличии сети; если apibay недоступен — отметь в Журнале, не блок).

## Вне рамок шага

RuTracker (шаг 13), ранжирование и сохранение в БД (шаг 14).
