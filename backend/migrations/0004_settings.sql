-- Настройки, редактируемые из UI (поверх env-дефолтов). Одна запись key = 'settings'.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
