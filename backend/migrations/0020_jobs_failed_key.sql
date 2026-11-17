-- Ревью B14: успешно завершившаяся задача убирает свои прежние неудачи (`jobs::complete`), а проверка
-- инвариантов ищет последнюю строку ключа — оба запроса идут по `dedup_key` среди `failed`.
CREATE INDEX jobs_failed_key_idx ON jobs (dedup_key) WHERE state = 'failed';
