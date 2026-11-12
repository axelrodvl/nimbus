-- Прогресс длинных задач (сейчас — import_artist): фаза, счётчики и журнал шагов для UI.
ALTER TABLE jobs ADD COLUMN progress JSONB;
