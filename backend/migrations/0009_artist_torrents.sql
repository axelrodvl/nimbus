-- Раздачи-дискографии артиста (шаг 29): `discover_artist` теперь работает параллельно импорту
-- альбомов и может завершиться раньше, чем в библиотеке появятся альбомы, — найденное нужно
-- где-то хранить, чтобы привязать к альбомам, импортированным позже.
CREATE TABLE artist_torrents (
    artist_id   BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    torrent_id  BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    query       TEXT NOT NULL,
    rank_score  REAL NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (artist_id, torrent_id)
);
CREATE INDEX artist_torrents_torrent ON artist_torrents(torrent_id);

-- Backfill: дискографии, уже привязанные к альбомам артиста.
INSERT INTO artist_torrents (artist_id, torrent_id, query, rank_score)
SELECT DISTINCT ON (a.artist_id, at.torrent_id) a.artist_id, at.torrent_id, at.query, at.rank_score
FROM album_torrents at
  JOIN albums a ON a.id = at.album_id
  JOIN torrents t ON t.id = at.torrent_id AND t.kind = 'discography'
ORDER BY a.artist_id, at.torrent_id, at.rank_score DESC;
