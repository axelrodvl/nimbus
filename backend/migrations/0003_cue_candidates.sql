-- Образы с .cue, найденные при верификации раздачи (обрабатываются в шаге 21).
CREATE TABLE cue_candidates (
    torrent_id       BIGINT NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    album_id         BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    cue_file_index   INT NOT NULL,
    image_file_index INT NOT NULL,
    processed        BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (torrent_id, album_id, cue_file_index)
);
