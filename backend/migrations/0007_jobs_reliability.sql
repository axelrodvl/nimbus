-- Надёжность очереди: приоритеты и heartbeat (шаг 26).
ALTER TABLE jobs ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN heartbeat_at TIMESTAMPTZ;

DROP INDEX IF EXISTS jobs_ready_idx;
CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after, id) WHERE state = 'queued';
