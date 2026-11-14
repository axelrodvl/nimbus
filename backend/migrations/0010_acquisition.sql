-- Состояние поиска раздач по альбому (шаг 32): сколько поисков было, чем кончился последний,
-- когда авто-повтор. Состояние «приобретения» (searching/missing/…) вычисляется по трекам, не хранится.
CREATE TABLE album_search_state (
    album_id         BIGINT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
    attempts         INT NOT NULL DEFAULT 0,          -- завершённых поисков
    last_started_at  TIMESTAMPTZ,
    last_finished_at TIMESTAMPTZ,
    last_outcome     TEXT,                            -- found | partial | no_torrents | dead_torrents | no_match | search_failed
    candidates       INT NOT NULL DEFAULT 0,          -- сколько раздач дал последний поиск
    provider_errors  JSONB NOT NULL DEFAULT '[]',     -- [{source, error}]
    next_retry_at    TIMESTAMPTZ,                     -- когда авто-повтор (NULL — не планируется)
    auto_retries     INT NOT NULL DEFAULT 0           -- авто-повторов с последнего успеха/ручного запуска
);
CREATE INDEX album_search_retry_idx ON album_search_state (next_retry_at) WHERE next_retry_at IS NOT NULL;

-- Активные задачи по альбому (`active_jobs` в списке приобретения): discover_album, verify_torrent, process_cue.
CREATE INDEX jobs_active_album_idx ON jobs ((payload->>'album_id')) WHERE state IN ('queued', 'running');
