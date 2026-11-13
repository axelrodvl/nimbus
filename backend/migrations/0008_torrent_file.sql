-- Готовый .torrent раздачи (шаг 28): метаданные добываются из сети не более одного раза.
-- NULL — файла нет (получим из magnet и сохраним). Не входит в модель `Torrent` (только флаг).
ALTER TABLE torrents ADD COLUMN torrent_file BYTEA;
