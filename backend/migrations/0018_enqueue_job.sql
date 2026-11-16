-- Постановка задачи одной функцией (ревью B11). Каждый оператор внутри получает свежий снимок,
-- поэтому гонки с завершением и взятием активной задачи закрываются здесь, а не в вызывающем коде:
--   * активная задача с тем же ключом блокируется (FOR UPDATE) до конца транзакции вызывающего —
--     `claim` (SKIP LOCKED) не возьмёт ожидающую, а `complete` не завершит выполняющуюся, пока
--     данные запроса не закоммичены (иначе обработчик прочитал бы состояние без них);
--   * если активная задача завершилась между проверкой конфликта и блокировкой — вставка повторяется.
-- Возвращает id новой строки или NULL, если запрос учтён активной задачей (приоритет / `rerun`).
CREATE FUNCTION enqueue_job(
    p_kind TEXT, p_payload JSONB, p_dedup_key TEXT,
    p_run_after TIMESTAMPTZ, p_max_attempts INT, p_priority SMALLINT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
    new_id BIGINT;
    act RECORD;
BEGIN
    FOR i IN 1..10 LOOP
        INSERT INTO jobs (kind, payload, dedup_key, run_after, max_attempts, priority)
        VALUES (p_kind, p_payload, p_dedup_key, COALESCE(p_run_after, now()),
                COALESCE(p_max_attempts, 5), p_priority)
        ON CONFLICT (dedup_key) WHERE state IN ('queued','running') DO NOTHING
        RETURNING id INTO new_id;
        IF new_id IS NOT NULL THEN
            PERFORM pg_notify('jobs', new_id::text);
            RETURN new_id;
        END IF;

        SELECT j.id, j.state, j.rerun, j.priority INTO act FROM jobs j
        WHERE j.dedup_key = p_dedup_key AND j.state IN ('queued','running')
        FOR UPDATE;
        IF FOUND THEN
            IF (act.state = 'running' AND NOT act.rerun) OR act.priority < p_priority THEN
                UPDATE jobs SET rerun = (act.state = 'running') OR rerun,
                                priority = GREATEST(priority, p_priority), updated_at = now()
                WHERE id = act.id;
            END IF;
            RETURN NULL;
        END IF;
    END LOOP;
    RAISE EXCEPTION 'enqueue_job: active job % keeps vanishing', p_dedup_key;
END $$;
