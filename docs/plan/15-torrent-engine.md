# Шаг 15 — Торрент-движок: обёртка над librqbit

**Зависит от:** 03
**Оценка:** 2 дня

## Цель

Крейт `torrent` — единственное место, которое знает про librqbit. Он даёт остальной системе узкий интерфейс: получить список файлов по magnet без скачивания, начать качать конкретный файл, открыть поток чтения файла с позиции (последовательное скачивание с приоритетом текущей позиции), узнать прогресс, остановить/удалить.

## Важно

API librqbit меняется между версиями. **Перед написанием кода** прочитай документацию актуальной версии: https://docs.rs/librqbit и исходники `crates/librqbit` в https://github.com/ikatson/rqbit (особенно `session.rs`, `api.rs`, `torrent_state/streaming.rs`, `http_api.rs` — там есть готовый HTTP-стриминг с Range, это лучший образец). Скелет ниже описывает **контракт крейта**, а не точные вызовы librqbit.

Ориентиры по librqbit (проверить на актуальной версии):
- `Session::new_with_opts(output_dir, SessionOptions { persistence, dht, listen_port_range, … })`;
- `session.add_torrent(AddTorrent::from_url(magnet), Some(AddTorrentOptions { list_only: true, .. }))` → `AddTorrentResponse::ListOnly(ListOnlyResponse { info, .. })` — список файлов без скачивания;
- `AddTorrentOptions { only_files: Some(vec![idx]), paused, overwrite: true, .. }` — качать только выбранные файлы;
- `session.update_only_files(&handle, &HashSet<usize>)` — изменить набор файлов;
- `handle.stream(file_id)` → `FileStream`, реализует `AsyncRead + AsyncSeek`, при чтении приоритизирует нужные куски (это и есть sequential/streaming);
- `handle.stats()` — прогресс, скорость, пиры; `session.delete(id, delete_files)`.

## Что сделать

### 1. Публичный интерфейс

```rust
pub struct TorrentEngine { /* Arc<Session>, конфиг */ }

pub struct EngineConfig {
    pub data_dir: PathBuf,           // {NIMBUS_DATA_DIR}/torrents — скачанные файлы
    pub session_dir: PathBuf,        // {NIMBUS_DATA_DIR}/session — persistence librqbit
    pub listen_port: Option<u16>,    // по умолчанию диапазон 6881..6891
    pub seeding: bool,               // false → после завершения файла не раздавать (пауза / upload limit 0)
    pub metadata_timeout: Duration,  // 90 с
}

pub struct FileEntry { pub index: usize, pub path: String, pub size: u64 }   // path через '/', от корня торрента
pub struct TorrentMeta { pub info_hash: InfoHash, pub name: String, pub files: Vec<FileEntry>, pub piece_length: u32 }

pub struct FileProgress { pub bytes_done: u64, pub bytes_total: u64, pub peers: u32, pub down_speed_bps: u64, pub finished: bool }

pub enum EngineError { MetadataTimeout, InvalidMagnet(String), NotFound, Io(std::io::Error), Internal(String) }

impl TorrentEngine {
    pub async fn new(cfg: EngineConfig) -> Result<Self, EngineError>;

    /// Список файлов по magnet, без скачивания данных. Таймаут metadata_timeout.
    pub async fn fetch_metadata(&self, magnet: &str) -> Result<TorrentMeta, EngineError>;

    /// Гарантировать, что торрент добавлен в сессию и качается ровно этот файл
    /// (плюс уже выбранные ранее файлы — объединение множеств, см. ниже). Идемпотентно.
    pub async fn ensure_file(&self, magnet: &str, file_index: usize) -> Result<TorrentHandleId, EngineError>;

    /// Поток чтения файла. Чтение блокируется до прихода кусков; куски вокруг позиции чтения в приоритете.
    pub async fn open_stream(&self, id: TorrentHandleId, file_index: usize)
        -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError>;

    pub fn file_progress(&self, id: TorrentHandleId, file_index: usize) -> Option<FileProgress>;

    /// Абсолютный путь файла на диске (для отдачи из кэша после завершения).
    pub fn file_path(&self, id: TorrentHandleId, file_index: usize) -> Option<PathBuf>;

    /// Убрать файл из набора скачиваемых; если файлов не осталось — удалить торрент из сессии (данные — по флагу).
    pub async fn release_file(&self, id: TorrentHandleId, file_index: usize, delete_data: bool) -> Result<(), EngineError>;
}
pub trait AsyncReadSeek: AsyncRead + AsyncSeek {}
```

`TorrentHandleId` — newtype над id librqbit или над `InfoHash` (предпочтительно `InfoHash`: стабилен между перезапусками).

### 2. Детали реализации

- `fetch_metadata`: если торрент уже есть в сессии — взять файлы из его info, не ходя в сеть. Иначе `list_only`. Обернуть в `tokio::time::timeout`. Ограничить параллелизм (`Semaphore`, 4) — каждый fetch открывает DHT-поиск и соединения.
- Пути файлов: соединить компоненты через `/`; обработать однофайловые торренты (путь = `name`).
- `ensure_file`: хранить `HashMap<InfoHash, HashSet<usize>>` выбранных файлов; при добавлении нового индекса — `update_only_files` с объединением. Новый торрент — добавлять сразу с `only_files`, **никогда** не начинать качать весь торрент (дискографии на сотни ГБ).
- Куски на границах файлов будут скачаны целиком — это нормально.
- Persistence сессии включена: после рестарта торренты восстанавливаются; при старте синхронизировать карту выбранных файлов из сессии.
- `seeding = false`: после `finished` торрента — `pause` (или upload rate limit 0, если поддерживается). Проверить, не мешает ли пауза последующему `open_stream` уже скачанного файла (если мешает — отдавать с диска через `file_path`, это всё равно делает шаг 18).
- Логи: `tracing` span на info_hash.

### 3. Интеграция

- `AppState` и `JobCtx` получают `engine: Arc<TorrentEngine>` (создаётся в `main.rs`, каталоги внутри `data_dir`).
- Отладочный эндпоинт (только debug): `POST /api/debug/torrent/metadata { magnet }` → `TorrentMeta` — для ручной проверки.

## Тесты

Сеть в CI может отсутствовать, поэтому основной тест — **локальный рой**:
- Интеграционный тест: создать во временной папке 2–3 файла (например, 3 МБ случайных байтов), сделать из них `.torrent` (через `librqbit::create_torrent` или аналог из `librqbit-core`), поднять **вторую** сессию librqbit как сидера на localhost (DHT выключить, `initial_peers` = адрес сидера), затем:
  - `fetch_metadata` по magnet с `x.pe=127.0.0.1:<port>` (или через API добавления пиров) → правильные пути и размеры;
  - `ensure_file(1)` + `open_stream` → `seek` в середину → прочитанные байты совпадают с оригиналом; файл 0 при этом не скачан (размер на диске / прогресс 0);
  - `file_progress` доходит до `finished`.
  Если создать локальный рой не получается — описать причину в Журнале, оставить тест `#[ignore]` и сделать живой `#[ignore]`-тест на легальной раздаче (например, Ubuntu ISO torrent или [Internet Archive](https://archive.org) торрент с музыкой в public domain).
- Unit: сборка путей, объединение `only_files`.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят (тест локального роя проходит или обоснованно помечен `#[ignore]` в Журнале).
- С сетью: `curl -XPOST localhost:8080/api/debug/torrent/metadata -d '{"magnet":"<magnet легальной раздачи>"}' -H 'content-type: application/json'` возвращает список файлов за < 90 с.

## Вне рамок шага

Сопоставление файлов (шаг 16), HTTP-стриминг (шаг 18).
