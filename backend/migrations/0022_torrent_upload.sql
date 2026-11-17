-- Накопительная отдача по торрентам: движок считает её только за сессию (после перезапуска — с нуля).
-- `uploaded_bytes` — сумма завершённых сессий, `session_bytes` — последнее записанное значение текущей.
CREATE TABLE torrent_upload (
    info_hash      text PRIMARY KEY,
    uploaded_bytes bigint NOT NULL DEFAULT 0,
    session_bytes  bigint NOT NULL DEFAULT 0
);
