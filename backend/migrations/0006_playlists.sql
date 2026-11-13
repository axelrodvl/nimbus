-- Счётчик прослушиваний треков и пользовательские плейлисты.
-- Favorites — динамический плейлист (Топ-100 по play_count), в БД не хранится.

CREATE TABLE track_plays (
    track_id        BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    play_count      INTEGER NOT NULL DEFAULT 0,
    last_played_at  TIMESTAMPTZ
);
CREATE INDEX track_plays_top ON track_plays (play_count DESC, last_played_at DESC);

CREATE TABLE playlists (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Последнее добавление трека: по нему сортируется список при выборе плейлиста.
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playlist_tracks (
    id           BIGSERIAL PRIMARY KEY,
    playlist_id  BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id     BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (playlist_id, track_id)
);
CREATE INDEX playlist_tracks_track ON playlist_tracks (track_id);
