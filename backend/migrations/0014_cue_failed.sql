-- Разбор CUE мог не удасться по временной причине (нет пиров, ошибка движка): такого кандидата
-- повторяет следующий повтор альбома. `failed` — «обработан неуспешно, но не окончательно».
ALTER TABLE cue_candidates ADD COLUMN failed BOOLEAN NOT NULL DEFAULT FALSE;

-- Уже закрытым кандидатам, от которых не появилось ни одного источника, даём вторую попытку.
UPDATE cue_candidates c SET failed = TRUE
WHERE c.processed
  AND NOT EXISTS (SELECT 1 FROM track_sources ts
                  WHERE ts.torrent_id = c.torrent_id AND ts.cue_start_ms IS NOT NULL);
