-- Признак «у артиста есть фото» (ревью S12): клиент знает его из синхронизации и не запрашивает
-- `/api/artist-image/{mbid}` для артиста без фото. NULL — ещё не искали.
-- Колонка пишется там же, где `mb_cache` `artist_image:{mbid}`; запись штампует `sync_txid` триггером `artists_sync`.
ALTER TABLE artists ADD COLUMN image TEXT CHECK (image IN ('yes', 'no'));
