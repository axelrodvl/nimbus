# Шаг 04 — Схема БД, доменные модели, репозитории

**Зависит от:** 03
**Оценка:** 1–1.5 дня

## Цель

Создать полную схему БД (кроме `settings` — шаг 22), доменные типы в `core` и репозитории в `db` с тестами. Это фундамент для всех остальных бэкенд-шагов — контракты отсюда используются дальше без изменений.

## Что сделать

### 1. Миграция `backend/migrations/0002_schema.sql`

```sql
-- Артисты
CREATE TABLE artists (
    id              BIGSERIAL PRIMARY KEY,
    mbid            UUID NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    sort_name       TEXT,
    disambiguation  TEXT,
    in_library      BOOLEAN NOT NULL DEFAULT FALSE,
    added_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Альбомы = MusicBrainz release group + выбранный каноничный release
CREATE TABLE albums (
    id                  BIGSERIAL PRIMARY KEY,
    mbid_release_group  UUID NOT NULL UNIQUE,
    mbid_release        UUID,
    artist_id           BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    primary_type        TEXT,                 -- Album | EP | Single | ...
    secondary_types     TEXT[] NOT NULL DEFAULT '{}',
    year                INT,
    cover_url           TEXT,
    in_library          BOOLEAN NOT NULL DEFAULT FALSE,  -- альбом добавлен целиком
    added_at            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX albums_artist_idx ON albums(artist_id);

CREATE TABLE tracks (
    id              BIGSERIAL PRIMARY KEY,
    mbid_recording  UUID NOT NULL,
    mbid_track      UUID UNIQUE,              -- id трека в конкретном release
    album_id        BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id       BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    disc_no         INT NOT NULL DEFAULT 1,
    position        INT NOT NULL,
    duration_ms     INT,
    status          TEXT NOT NULL DEFAULT 'adding'
                    CHECK (status IN ('adding','found','not_found','ready')),
    status_reason   TEXT,                     -- no_torrents | dead_torrents | no_match | ...
    in_library      BOOLEAN NOT NULL DEFAULT FALSE,
    added_at        TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (album_id, disc_no, position)
);
CREATE INDEX tracks_recording_idx ON tracks(mbid_recording);
CREATE INDEX tracks_status_idx ON tracks(status);

CREATE TABLE torrents (
    id               BIGSERIAL PRIMARY KEY,
    info_hash        TEXT NOT NULL UNIQUE CHECK (info_hash ~ '^[0-9a-f]{40}$'),
    magnet           TEXT NOT NULL,
    source           TEXT NOT NULL,           -- tpb | rutracker | torznab | manual
    source_topic_id  TEXT,
    title            TEXT NOT NULL,
    size_bytes       BIGINT,
    seeders          INT,
    leechers         INT,
    kind             TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (kind IN ('album','discography','single','unknown')),
    meta_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (meta_status IN ('pending','fetching','ok','timeout','dead','error')),
    meta_attempts    INT NOT NULL DEFAULT 0,
    meta_error       TEXT,
    fetched_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE torrent_files (
    torrent_id   BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    file_index   INT NOT NULL,
    path         TEXT NOT NULL,               -- путь внутри торрента, '/'-разделитель
    size_bytes   BIGINT NOT NULL,
    ext          TEXT,                        -- нижний регистр, без точки
    PRIMARY KEY (torrent_id, file_index)
);

CREATE TABLE album_torrents (
    album_id     BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    torrent_id   BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    query        TEXT NOT NULL,
    rank_score   REAL NOT NULL,
    verified     BOOLEAN NOT NULL DEFAULT FALSE,  -- верификация для этого альбома завершена
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, torrent_id)
);

CREATE TABLE track_sources (
    id                  BIGSERIAL PRIMARY KEY,
    track_id            BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    torrent_id          BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    file_index          INT NOT NULL,
    match_score         REAL NOT NULL,
    is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
    needs_confirmation  BOOLEAN NOT NULL DEFAULT FALSE,
    cue_start_ms        INT,                  -- для CUE-образов (шаг 21)
    cue_end_ms          INT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (track_id, torrent_id, file_index)
);
CREATE UNIQUE INDEX track_sources_one_primary ON track_sources(track_id) WHERE is_primary;

CREATE TABLE downloads (
    torrent_id      BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    file_index      INT NOT NULL,
    local_path      TEXT NOT NULL,
    bytes_total     BIGINT NOT NULL,
    bytes_done      BIGINT NOT NULL DEFAULT 0,
    completed_at    TIMESTAMPTZ,
    last_played_at  TIMESTAMPTZ,
    PRIMARY KEY (torrent_id, file_index)
);

CREATE TABLE jobs (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    state         TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','done','failed')),
    attempts      INT NOT NULL DEFAULT 0,
    max_attempts  INT NOT NULL DEFAULT 5,
    run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    last_error    TEXT,
    dedup_key     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(run_after) WHERE state = 'queued';
CREATE UNIQUE INDEX jobs_dedup_active ON jobs(dedup_key) WHERE state IN ('queued','running');

CREATE TABLE mb_cache (
    key         TEXT PRIMARY KEY,
    response    JSONB NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);
```

### 2. Доменные типы в `core` (`core::model`)

- `TrackStatus { Adding, Found, NotFound, Ready }` — `serde(rename_all = "snake_case")`, `sqlx::Type` через `#[sqlx(type_name = "text", rename_all = "snake_case")]` (или `FromStr`/`Display` + ручной маппинг), `Display`.
- `NotFoundReason { NoTorrents, DeadTorrents, NoMatch }` — сериализуется в `status_reason`.
- `TorrentKind`, `MetaStatus`, `TorrentSource { Tpb, Rutracker, Torznab, Manual }` — аналогично.
- Структуры-строки: `Artist`, `Album`, `Track`, `Torrent`, `TorrentFile`, `AlbumTorrent`, `TrackSource`, `Download` — поля 1:1 с таблицами, `#[derive(Debug, Clone, Serialize, sqlx::FromRow)]`.
- `InfoHash(String)` — newtype с валидацией (40 hex, нижний регистр; поддержать разбор base32 32 символа → hex), `fn from_magnet(&str) -> Option<InfoHash>`.

`core` не должен зависеть от `db`; `sqlx` в `core` подключить только с фичей `derive` (или держать `FromRow` в `db` — на твоё усмотрение, но без циклических зависимостей).

### 3. Репозитории в `db` (`db::repo::*`), функции принимают `impl PgExecutor` или `&PgPool`

- `artists`: `upsert_by_mbid(NewArtist) -> Artist`, `get(id)`, `get_by_mbid`, `set_in_library(id, bool)`, `list_in_library(cursor, limit)`.
- `albums`: `upsert_by_rg_mbid(NewAlbum) -> Album`, `get(id)`, `list_by_artist(artist_id)`, `set_in_library`, `list_in_library(cursor, limit)`.
- `tracks`: `upsert_by_mbid_track(NewTrack) -> Track` (при конфликте **не** сбрасывать `status`), `get(id)`, `list_by_album(album_id)`, `set_status(id, status, reason) -> Track` (обновляет `updated_at`), `set_status_for_album(album_id, from: &[TrackStatus], to, reason) -> Vec<Track>`, `set_in_library`, `list_in_library(filter: { status: Option<TrackStatus> }, cursor, limit)`.
- `torrents`: `upsert_by_info_hash(NewTorrent) -> Torrent` (при конфликте обновлять seeders/leechers/title, не трогать meta_*), `get`, `set_meta_status`, `replace_files(torrent_id, Vec<NewTorrentFile>)` (в транзакции), `files(torrent_id)`.
- `album_torrents`: `link(album_id, torrent_id, query, rank_score)` (ON CONFLICT — max(rank_score)), `list_for_album(album_id)` (join с torrents, сортировка по rank_score desc), `mark_verified(album_id, torrent_id)`, `count_unverified(album_id)`.
- `track_sources`: `insert(...)`, `list_for_track(track_id)`, `primary_for_track(track_id)`, `set_primary(track_id, source_id)` (в транзакции: снять старый primary, поставить новый).
- `downloads`: `upsert`, `get(torrent_id, file_index)`, `mark_completed`, `touch_played`.
- `mb_cache`: `get(key) -> Option<Value>` (только не истёкшие), `put(key, value, ttl)`, `purge_expired()`.

Курсорная пагинация: `cursor` = последний `id` (по убыванию `added_at, id` для библиотеки — допустимо упростить до `id DESC`).

После написания запросов выполнить `cargo sqlx prepare --workspace` (установить `cargo install sqlx-cli --no-default-features --features rustls,postgres`) и закоммитить `.sqlx/`, чтобы сборка работала без БД (`SQLX_OFFLINE=true`).

## Тесты

`#[sqlx::test(migrations = "../../migrations")]` для каждого репозитория:
- upsert идемпотентен, повторный upsert трека не сбрасывает статус;
- `set_primary` оставляет ровно один primary;
- `replace_files` заменяет набор целиком;
- CHECK-ограничения отклоняют неверный статус/info_hash;
- unit-тесты `InfoHash::from_magnet` (hex, base32, мусор).

## Критерии приёмки

- `just db-reset && just backend` — миграции применяются, сервер стартует.
- `just backend-test`, `just backend-check` проходят.
- `SQLX_OFFLINE=true cargo build --workspace` собирается.

## Вне рамок шага

HTTP-эндпоинты (кроме health), очередь задач (шаг 05).
