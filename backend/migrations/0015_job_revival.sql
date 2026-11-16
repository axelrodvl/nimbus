-- Оживление упавших задач (B05): `fatal` — задача провалена окончательно (повтор бессмыслен),
-- `revivals` — сколько раз её оживляло обслуживание. Существующие `failed` получают `fatal = FALSE`,
-- т. е. будут оживлены.
ALTER TABLE jobs ADD COLUMN fatal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN revivals INT NOT NULL DEFAULT 0;
CREATE INDEX jobs_failed_idx ON jobs (kind, updated_at) WHERE state = 'failed';
