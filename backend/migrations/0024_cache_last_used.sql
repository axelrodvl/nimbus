-- Кэш MusicBrainz и найденные раздачи никогда не удаляются сами: библиотека «прогревается» со временем. Отметка
-- последнего использования — задел под LRU, если метаданные когда-нибудь разрастутся (оценка: ~2 МБ на артиста).
ALTER TABLE mb_cache ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE torrents ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
