# Шаг 28 — Быстрые метаданные: `.torrent` в БД, параллелизм, мгновенный старт

**Фаза 1 · Зависит от:** 26, 27 · **Закрывает находки:** T2, T6, D3

## Зачем

Самая долгая операция конвейера — получение метаданных торрента по magnet (DHT + пиры, до десятков
секунд). Сейчас она выполняется **дважды** (при проверке раздачи и снова при первом воспроизведении),
идёт в 4 потока, а `.torrent`-файлы, уже скачанные провайдером, выбрасываются. После шага метаданные
каждого торрента добываются из сети не более одного раза, а часто — ни разу; воспроизведение найденного
трека стартует без ожидания метаданных.

## Текущее состояние

- `backend/crates/torrent/src/lib.rs`:
  - `fetch_metadata(magnet)` → `add_torrent(.., list_only: true)`; из `AddTorrentResponse::ListOnly(r)` берётся только `r.info`, а `r.torrent_bytes` (готовый `.torrent`) теряется;
  - `ensure_file(magnet, idx)` → `AddTorrent::from_url(magnet)` — снова сеть;
  - `METADATA_CONCURRENCY = 4`, `metadata_timeout = 45 с`.
- `backend/crates/worker/src/verify.rs` — `load_files`: при таймауте повтор через `RETRY_STEP = 15 мин × attempts`, `MAX_META_ATTEMPTS = 3`.
- `backend/crates/trackers/src/torznab.rs` — скачивает `.torrent`, считает info-hash (`torrent_file::info_hash_of_torrent`) и выбрасывает байты.
- `backend/crates/trackers/src/types.rs` — `TorrentCandidate`.
- `backend/crates/core/src/model.rs` — `Torrent`, `NewTorrent`; `backend/crates/db/src/repo/torrents.rs` — `upsert_by_info_hash`, `replace_files`, `set_meta_status`.
- Потребители `FileProvider::ensure_file(magnet, idx)`: `crates/api/src/stream.rs` (`open_reader`, `register_download`), `crates/worker/src/cue.rs`; фейки — в `crates/api/tests/common`, `crates/worker/tests`.
- В librqbit: `AddTorrent::from_bytes`, `ListOnlyResponse.torrent_bytes`, `AddTorrentOptions` (проверь по исходникам наличие полей `trackers`, `initial_peers`).

## Что сделать

1. **Миграция `0008_torrent_file.sql`:** `ALTER TABLE torrents ADD COLUMN torrent_file BYTEA;` (может быть `NULL`).
   Репозиторий: `torrents::set_torrent_file(id, &[u8])`, `torrents::torrent_file(id) -> Option<Vec<u8>>`.
   **Не** включай колонку в `SELECT *`-модель `Torrent` (чтобы не таскать мегабайты в каждом запросе): в `Torrent` добавь только `has_torrent_file: bool` (`torrent_file IS NOT NULL`), перечисли колонки явно.
2. **Источник торрента как тип.** В `nimbus-torrent`:
   ```rust
   pub struct TorrentRef { pub magnet: String, pub torrent_file: Option<bytes::Bytes> }
   pub struct TorrentMeta { /* как сейчас */ pub torrent_file: Option<bytes::Bytes> }
   pub fn parse_torrent_file(bytes: &[u8]) -> Result<TorrentMeta, EngineError>;  // без сети
   ```
   - `fetch_metadata` возвращает `torrent_file: Some(r.torrent_bytes)` из `ListOnly`.
   - `ensure_file(s)`/`open`-путь принимают `&TorrentRef`: при наличии байтов — `AddTorrent::from_bytes` (трекеры из magnet передать в опциях добавления, если поле есть), иначе — по magnet. При добавлении по magnet после получения метаданных — вернуть байты вызывающему (см. п. 4), чтобы сохранить.
   - `parse_torrent_file` проверяет, что info-hash байтов совпадает с ожидаемым (если передан) — иначе `EngineError::Internal("info-hash mismatch")`.
   - Сигнатуры трейтов `MetadataFetcher`/`FileProvider` и все фейки обновить.
3. **Verify без сети, когда можно.** `verify::load_files`:
   - если у торрента есть `torrent_file` → `parse_torrent_file` → `replace_files`, `meta_status = ok`, сеть не трогаем;
   - иначе `fetch_metadata`; при успехе сохранить `torrent_file`.
   Повторы после таймаута: 1 мин, 5 мин, 30 мин (вместо 15/30 мин); третья неудача → `dead`, как сейчас.
4. **Старт воспроизведения без сети.** В `api/src/stream.rs` (`open_reader`, `register_download`, `prefetch_head`) и
   `worker/src/cue.rs` собирать `TorrentRef` из БД (`magnet` + `torrent_file`). Если байтов в БД не было, а движок их получил при добавлении — сохранить.
5. **Провайдеры отдают `.torrent`.** В `TorrentCandidate` добавить `torrent_file: Option<Vec<u8>>`:
   - Torznab: байты, уже скачанные для info-hash, класть в кандидата;
   - RuTracker: не трогать (magnet из API/страницы достаточно; скачивание `dl.php` требует сессии и тратит лимит);
   - TPB: `None`.
   `discover::store` → после `upsert_by_info_hash` сохранить байты (если есть и ещё не сохранены) и сразу
   разобрать список файлов (`parse_torrent_file` → `replace_files`, `meta_status = ok`) — verify для такой раздачи станет мгновенным.
   Ограничение размера: `.torrent` больше 8 МБ не сохранять (лог `warn`).
6. **Параллелизм метаданных из настроек.** В `PerformanceSettings` добавить
   `metadata_concurrency: u8 = 16` (`1..=64`) и `metadata_timeout_secs: u16 = 30` (`5..=300`).
   `EngineConfig` получает оба значения при старте (`main.rs`); `Semaphore::new(metadata_concurrency)`.
   Семафор ограничивает только сетевой путь `fetch_metadata` (не `parse_torrent_file`).
7. **Публичные трекеры в magnet.** Убедись, что magnet, который строится для кандидатов без готового magnet
   (`build_magnet(.., PUBLIC_TRACKERS)`), содержит актуальный список трекеров; для magnet, пришедших от провайдера без `tr=`,
   — дополнять `PUBLIC_TRACKERS` при добавлении в движок (не меняя сохранённый magnet). Это ускоряет поиск пиров без DHT.
8. **DHT между рестартами.** Проверь по исходникам librqbit, сохраняется ли таблица маршрутизации DHT
   (опции persistence DHT в `SessionOptions`). Если отключено по умолчанию или пишется вне `NIMBUS_DATA_DIR` — включить и направить в `{data_dir}/session`.
9. **Дозаполнение.** Одноразово при старте (фоновая задача, не блокирует запуск): для торрентов, которые
   уже есть в сессии librqbit, но без `torrent_file` в БД, — достать байты из сессии, если API это позволяет; иначе пропустить.

## Тесты (обязательные)

`crates/torrent` (локальный рой):
- `fetch_metadata` возвращает `torrent_file`; `parse_torrent_file(эти байты)` даёт тот же `TorrentMeta` (имя, файлы, размеры, piece_length);
- `parse_torrent_file` на мусоре → ошибка; на чужом info-hash → ошибка несовпадения;
- **`ensure_file` по байтам при недоступности метаданных:** останови сидера, создай движок с `metadata_timeout = 1 с` → `ensure_file` с байтами завершается успешно сразу (торрент добавлен, файл выбран), а без байтов — `MetadataTimeout`;
- с байтами + живым сидером стрим читает корректные данные;
- семафор: при `metadata_concurrency = 2` и 5 одновременных `fetch_metadata` на «глухие» magnet одновременно выполняется не больше 2 (счётчик через тестовый хук или измерение времени при `timeout = 300 мс`: общее время ≥ 3 × таймаут).

`crates/worker/tests/verify.rs`:
- у торрента есть `torrent_file` → fetcher **не вызывается** (фейк паникует при вызове), файлы и сопоставление на месте;
- после сетевого `fetch_metadata` байты сохранены в БД;
- расписание повторов 1/5/30 мин.

`crates/worker/tests/discover.rs`: кандидат с `torrent_file` → `torrent_files` заполнены, `meta_status = ok` ещё до verify.
`crates/trackers/tests/providers.rs`: Torznab кладёт байты в кандидата; `.torrent` > 8 МБ отбрасывается.
`crates/api/tests/stream.rs`: стрим собирает `TorrentRef` с байтами из БД (фейковый `FileProvider` фиксирует, что получил байты); байты, полученные движком, сохраняются.
`crates/db/tests/repos.rs`: `set_torrent_file`/`torrent_file`, `has_torrent_file`.
`crates/api/tests/settings.rs`: валидация новых полей `performance`.

## Критерии приёмки

```
just db-up && just check && just test && just cov
just openapi && just web-gen-api && just web-check
```
В Журнал — измерение на локальном рое: время от `ensure_file` до первого байта стрима с байтами и без.

## Не входит в шаг

- Изменение порядка и параллелизма задач discover/verify (шаг 29).
- Внешние кэши `.torrent` (itorrents и т.п.) — ненадёжны, не используем.

## Подводные камни

- `ListOnlyResponse.torrent_bytes` может не содержать список трекеров из magnet — поэтому трекеры передаются отдельно при добавлении по байтам.
- `SELECT *` в `sqlx::query_as` для `Torrent` после добавления `BYTEA` начнёт тянуть файл — обязательно перечисли колонки.
- Не логируй содержимое `.torrent` и не возвращай его в API/DTO.
- Обновляя сигнатуру `FileProvider`, не забудь фейки в `crates/api/src/fakes.rs` и e2e-сценарий (`docker-compose.e2e.yml`).
