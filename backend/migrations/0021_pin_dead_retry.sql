-- B15: закрепления `failed` без расписания (`dead`, постоянные отказы) теперь повторяются по расписанию.
-- После обновления всё пробуется заново.
UPDATE pinned_tracks SET next_retry_at = now() WHERE state = 'failed' AND next_retry_at IS NULL;
