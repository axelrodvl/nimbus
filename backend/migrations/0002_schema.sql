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
