-- Защита от crash-loop (ревью B07): сколько раз задача была `running` в момент нештатного
-- завершения процесса. Штатная остановка счётчик не трогает.
ALTER TABLE jobs ADD COLUMN crashes INT NOT NULL DEFAULT 0;
