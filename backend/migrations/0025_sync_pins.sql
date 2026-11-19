-- Закрепления в синхронизации (ревью S11): клиент знает серверное состояние альбома из своих данных,
-- без запроса при каждом открытии. Поля `pin`/`pin_error` трека читаются из `pinned_tracks`, поэтому
-- изменение закрепления «касается» трека, как изменения `track_sources`/`track_plays` (0012_sync.sql).
--
-- Только то, что видит клиент: вставка, удаление и смена `state`/`error`. Служебные `retries`,
-- `next_retry_at`, `updated_at` меняются часто (повторы загрузок) и дельты не дают. Список колонок
-- у триггера с transition tables Postgres не допускает — фильтр внутри функции.

CREATE FUNCTION sync_touch_tracks_pins_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sync_touch_tracks(ARRAY(
        SELECT n.track_id FROM new_rows n JOIN old_rows o ON o.track_id = n.track_id
         WHERE n.state IS DISTINCT FROM o.state OR n.error IS DISTINCT FROM o.error
        -- Строку могли переназначить на другой трек (в коде так не делается, но тогда тронуты оба).
        UNION SELECT n.track_id FROM new_rows n WHERE NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.track_id = n.track_id)
        UNION SELECT o.track_id FROM old_rows o WHERE NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.track_id = o.track_id)));
    RETURN NULL;
END $$;

CREATE TRIGGER pinned_tracks_sync_ins AFTER INSERT ON pinned_tracks
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_new();
CREATE TRIGGER pinned_tracks_sync_upd AFTER UPDATE ON pinned_tracks
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_pins_upd();
CREATE TRIGGER pinned_tracks_sync_del AFTER DELETE ON pinned_tracks
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_touch_tracks_old();
