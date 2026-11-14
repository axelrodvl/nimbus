-- Синхронизация клиента (шаг 34): у каждой синхронизируемой строки — номер транзакции, которая
-- записала её последней; удаления — в таблице надгробий. Код приложения про `sync_txid` не знает.

ALTER TABLE artists         ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE albums          ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tracks          ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE playlists       ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE playlist_tracks ADD COLUMN sync_txid BIGINT NOT NULL DEFAULT 0;

CREATE INDEX artists_sync_idx         ON artists (sync_txid);
CREATE INDEX albums_sync_idx          ON albums (sync_txid);
CREATE INDEX tracks_sync_idx          ON tracks (sync_txid);
CREATE INDEX playlists_sync_idx       ON playlists (sync_txid);
CREATE INDEX playlist_tracks_sync_idx ON playlist_tracks (sync_txid);

-- Штамп транзакции. Срабатывает и на UPDATE, ничего не менявший: «касание» производных полей
-- (см. ниже) рассчитывает именно на это. `txid_current()` — 64-битный, с эпохой.
CREATE FUNCTION sync_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.sync_txid := txid_current();
    PERFORM pg_notify('nimbus_sync', '');
    RETURN NEW;
END $$;

CREATE TRIGGER artists_sync         BEFORE INSERT OR UPDATE ON artists         FOR EACH ROW EXECUTE FUNCTION sync_stamp();
CREATE TRIGGER albums_sync          BEFORE INSERT OR UPDATE ON albums          FOR EACH ROW EXECUTE FUNCTION sync_stamp();
CREATE TRIGGER tracks_sync          BEFORE INSERT OR UPDATE ON tracks          FOR EACH ROW EXECUTE FUNCTION sync_stamp();
CREATE TRIGGER playlists_sync       BEFORE INSERT OR UPDATE ON playlists       FOR EACH ROW EXECUTE FUNCTION sync_stamp();
CREATE TRIGGER playlist_tracks_sync BEFORE INSERT OR UPDATE ON playlist_tracks FOR EACH ROW EXECUTE FUNCTION sync_stamp();

-- Надгробия: удалённая строка остаётся здесь, пока клиенты не успеют о ней узнать
-- (чистка — `purge_tombstones`, старше 30 дней).
CREATE TABLE sync_tombstones (
    entity     TEXT NOT NULL CHECK (entity IN ('artist','album','track','playlist','playlist_track')),
    entity_id  BIGINT NOT NULL,
    sync_txid  BIGINT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (entity, entity_id)
);
CREATE INDEX sync_tombstones_txid_idx ON sync_tombstones (sync_txid);
CREATE INDEX sync_tombstones_deleted_idx ON sync_tombstones (deleted_at);

-- Имя сущности передаётся аргументом триггера (TG_ARGV[0]).
CREATE FUNCTION sync_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO sync_tombstones (entity, entity_id, sync_txid)
    VALUES (TG_ARGV[0], OLD.id, txid_current())
    ON CONFLICT (entity, entity_id)
    DO UPDATE SET sync_txid = EXCLUDED.sync_txid, deleted_at = now();
    PERFORM pg_notify('nimbus_sync', '');
    RETURN NULL;
END $$;

CREATE TRIGGER artists_tomb         AFTER DELETE ON artists         FOR EACH ROW EXECUTE FUNCTION sync_tombstone('artist');
CREATE TRIGGER albums_tomb          AFTER DELETE ON albums          FOR EACH ROW EXECUTE FUNCTION sync_tombstone('album');
CREATE TRIGGER tracks_tomb          AFTER DELETE ON tracks          FOR EACH ROW EXECUTE FUNCTION sync_tombstone('track');
CREATE TRIGGER playlists_tomb       AFTER DELETE ON playlists       FOR EACH ROW EXECUTE FUNCTION sync_tombstone('playlist');
CREATE TRIGGER playlist_tracks_tomb AFTER DELETE ON playlist_tracks FOR EACH ROW EXECUTE FUNCTION sync_tombstone('playlist_track');

-- Производные поля трека (`needs_confirmation`, режим воспроизведения, счётчик прослушиваний)
-- живут в `track_sources` и `track_plays`: их изменение «касается» затронутых треков.
-- Триггеры уровня оператора (массовые вставки verify не должны давать N вызовов); transition
-- tables в Postgres допускаются только по одному виду операции на триггер.
-- Строки блокируются в порядке id: две параллельные массовые вставки источников (verify) иначе
-- могли бы взаимно заблокироваться, обновляя одни и те же треки в разном порядке.
CREATE FUNCTION sync_touch_tracks(ids BIGINT[]) RETURNS void LANGUAGE sql AS $$
    WITH locked AS (SELECT id FROM tracks WHERE id = ANY(ids) ORDER BY id FOR UPDATE)
    UPDATE tracks t SET sync_txid = txid_current() FROM locked WHERE t.id = locked.id
$$;

CREATE FUNCTION sync_touch_tracks_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sync_touch_tracks(ARRAY(SELECT DISTINCT track_id FROM new_rows));
    RETURN NULL;
END $$;

CREATE FUNCTION sync_touch_tracks_old() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sync_touch_tracks(ARRAY(SELECT DISTINCT track_id FROM old_rows));
    RETURN NULL;
END $$;

-- UPDATE: затронуты и старый, и новый трек (строку могли переназначить).
CREATE FUNCTION sync_touch_tracks_both() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sync_touch_tracks(ARRAY(SELECT track_id FROM new_rows UNION SELECT track_id FROM old_rows));
    RETURN NULL;
END $$;

CREATE TRIGGER track_sources_sync_ins AFTER INSERT ON track_sources
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_new();
CREATE TRIGGER track_sources_sync_upd AFTER UPDATE ON track_sources
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_both();
CREATE TRIGGER track_sources_sync_del AFTER DELETE ON track_sources
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_old();

CREATE TRIGGER track_plays_sync_ins AFTER INSERT ON track_plays
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_new();
CREATE TRIGGER track_plays_sync_upd AFTER UPDATE ON track_plays
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_both();
CREATE TRIGGER track_plays_sync_del AFTER DELETE ON track_plays
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_old();

-- Идентификатор базы и нижняя граница курсоров (`floor` растёт при чистке надгробий).
INSERT INTO settings (key, value)
VALUES ('sync', jsonb_build_object('epoch', gen_random_uuid()::text, 'floor', 0))
ON CONFLICT (key) DO NOTHING;
