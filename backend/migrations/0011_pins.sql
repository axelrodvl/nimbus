-- Закрепления (шаг 33): трек, который сервер должен скачать и не вытеснять из кэша.
-- Закрепление привязано к ТРЕКУ; файл вычисляется менеджером загрузок по primary-источнику в момент работы.
CREATE TABLE pinned_tracks (
    track_id     BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    album_pin    BOOLEAN NOT NULL DEFAULT FALSE,   -- закреплён в составе альбома
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','downloading','done','waiting_source','failed')),
    error        TEXT,
    retries      INT NOT NULL DEFAULT 0,           -- авто-повторов после `failed`
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pinned_tracks_state_idx ON pinned_tracks (state, requested_at);
