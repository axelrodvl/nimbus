-- Повторы закреплений (B04): `next_retry_at` — когда повторить `failed`; NULL — не повторять
-- (окончательная неудача или `dead`). Прежние `failed` получают новую жизнь: расписание с нуля.
ALTER TABLE pinned_tracks ADD COLUMN next_retry_at TIMESTAMPTZ;
UPDATE pinned_tracks SET retries = 0, next_retry_at = now() WHERE state = 'failed';
