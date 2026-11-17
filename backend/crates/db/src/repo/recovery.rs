//! «Рывок восстановления» при первом запуске новой версии: всё отложенное по старым расписаниям
//! пробуется сразу (исправленный matcher, провайдеры и очередь могли это починить).

use nimbus_core::jobs::Job;
use sqlx::PgPool;

use super::jobs::{self, EnqueueOpts};

/// Виды задач, которые рывок возвращает в очередь (те же, что оживляет обслуживание).
const KICK_KINDS: [&str; 2] = [Job::IMPORT_ARTIST, Job::DISCOVER_ARTIST];

/// Попыток у импорта артиста (как у `nimbus_library::IMPORT_MAX_ATTEMPTS`).
const IMPORT_ATTEMPTS: i32 = 8;

/// Сколько чего сдвинул [`kick`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KickReport {
    /// Альбомы, которым назначен авто-повтор «сейчас».
    pub albums: u64,
    /// Закрепления `failed`, возвращённые в очередь.
    pub pins: u64,
    /// Упавшие нефатальные задачи, поставленные в очередь заново.
    pub jobs: u64,
    /// Артисты без импорта, которым поставлен импорт.
    pub imports: u64,
}

/// Рывок восстановления одной транзакцией. `max_crashes` — порог задач, ронявших процесс:
/// их не трогаем, оживит обычное обслуживание по расписанию.
pub async fn kick(db: &PgPool, max_crashes: i32) -> sqlx::Result<KickReport> {
    let mut tx = db.begin().await?;

    // Условие то же, что у `schedule_missing_now`; лестница пауз начинается заново.
    let albums = super::acquisition::restart_missing_now(&mut *tx).await?;

    let pins = sqlx::query(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, retries = 0,
                next_retry_at = NULL, updated_at = now()
         WHERE state = 'failed'",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let revived = sqlx::query(
        "WITH upd AS (
            UPDATE jobs j SET state = 'queued', attempts = 0, revivals = 0, run_after = now(),
                              deferred_since = NULL, rerun = FALSE, updated_at = now()
            WHERE j.state = 'failed' AND NOT j.fatal AND j.kind = ANY($1) AND j.crashes < $2
              AND j.id = (SELECT max(x.id) FROM jobs x WHERE x.dedup_key = j.dedup_key)
              AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.dedup_key = j.dedup_key
                              AND a.state IN ('queued','running'))
            RETURNING j.id
         )
         SELECT pg_notify('jobs', id::text) FROM upd",
    )
    .bind(&KICK_KINDS[..])
    .bind(max_crashes)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // После оживления задач: у кого осталась только упавшая (например, с крашами) — не «без импорта».
    let ids = super::artists::without_import(&mut *tx, std::time::Duration::ZERO).await?;
    let mut imports = 0;
    for id in ids {
        let queued = jobs::enqueue(
            &mut *tx,
            &Job::ImportArtist { artist_id: id },
            EnqueueOpts {
                max_attempts: Some(IMPORT_ATTEMPTS),
                ..EnqueueOpts::default()
            },
        )
        .await?;
        imports += u64::from(queued.is_some());
    }
    tx.commit().await?;
    Ok(KickReport {
        albums,
        pins,
        jobs: revived,
        imports,
    })
}
