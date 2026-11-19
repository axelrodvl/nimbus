-- Грубое состояние импорта дискографии в синхронизации (ревью S13): экран артиста рисует блок статуса
-- в первом кадре из store, без запроса. Значения — как `ImportState` в API (кроме `done` → NULL):
-- `queued`, `importing`, `retrying`, `failed`.
--
-- Пишется только на ПЕРЕХОДАХ задачи `import_artist` (постановка, взятие в работу, повтор, провал, успех).
-- Heartbeat и прогресс (`jobs.progress`, `heartbeat_at`, `updated_at`) состояние не меняют и дельт не дают:
-- обновление артиста идёт только при изменении значения. Запись штампует `sync_txid` триггером `artists_sync`.
ALTER TABLE artists ADD COLUMN import_state TEXT
    CHECK (import_state IN ('queued', 'importing', 'retrying', 'failed'));

-- Состояние по последней задаче артиста — та же логика, что `import_status` в `api/src/library.rs`.
CREATE FUNCTION artist_import_state(p_artist_id BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE
             WHEN j.state = 'running' THEN 'importing'
             WHEN j.state = 'queued' AND j.attempts = 0 THEN 'queued'
             WHEN j.state = 'queued' THEN 'retrying'
             WHEN j.state = 'failed' THEN 'failed'
           END
      FROM jobs j
     WHERE j.kind = 'import_artist' AND j.payload->>'artist_id' = p_artist_id::text
     ORDER BY j.id DESC LIMIT 1
$$;

CREATE FUNCTION sync_artist_import_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_artist BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Чистка старых задач (`purge_done`/`purge_failed`) может сменить «последнюю» задачу артиста.
        v_artist := (OLD.payload->>'artist_id')::bigint;
        UPDATE artists SET import_state = artist_import_state(v_artist)
         WHERE id = v_artist AND import_state IS DISTINCT FROM artist_import_state(v_artist);
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state AND NEW.attempts = OLD.attempts
       AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN
        RETURN NULL; -- heartbeat, прогресс, продление аренды
    END IF;
    v_artist := (NEW.payload->>'artist_id')::bigint;
    UPDATE artists SET import_state = artist_import_state(v_artist)
     WHERE id = v_artist AND import_state IS DISTINCT FROM artist_import_state(v_artist);
    RETURN NULL;
END $$;

CREATE TRIGGER jobs_artist_import_state AFTER INSERT OR UPDATE ON jobs
    FOR EACH ROW WHEN (NEW.kind = 'import_artist') EXECUTE FUNCTION sync_artist_import_state();
CREATE TRIGGER jobs_artist_import_state_del AFTER DELETE ON jobs
    FOR EACH ROW WHEN (OLD.kind = 'import_artist') EXECUTE FUNCTION sync_artist_import_state();

UPDATE artists SET import_state = artist_import_state(id)
 WHERE artist_import_state(id) IS NOT NULL;
