// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! `artists.import_state` (ревью S13): грубое состояние импорта пишется на переходах задачи `import_artist`
//! и не меняется на heartbeat и прогрессе — иначе клиентам уходила бы дельта на каждый тик.
use chrono::Utc;
use nimbus_core::jobs::Job;
use nimbus_core::model::NewArtist;
use nimbus_db::repo::jobs::{self, EnqueueOpts, ImportProgress};
use nimbus_db::repo::{artists, sync};
use sqlx::PgPool;
use uuid::Uuid;

const KINDS: &[&str] = &[Job::IMPORT_ARTIST];

async fn artist(pool: &PgPool) -> i64 {
    artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "A".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id
}

async fn state_of(pool: &PgPool, id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT import_state FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Версия строки артиста: меняется при любой записи (триггер `sync_stamp` штампует каждый UPDATE).
async fn stamp(pool: &PgPool, id: i64) -> i64 {
    sqlx::query_scalar("SELECT sync_txid FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_import_state_synced_on_transitions(pool: PgPool) {
    let id = artist(&pool).await;
    assert_eq!(state_of(&pool, id).await, None);

    // постановка
    let job = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: id },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("queued"));

    // взятие в работу
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("importing"));

    // сбой с повтором
    let retry_at = Utc::now() + chrono::Duration::minutes(5);
    jobs::fail(&pool, job, "w", "mb down", Some(retry_at), false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("retrying"));

    // повтор взят в работу
    sqlx::query("UPDATE jobs SET run_after = now()")
        .execute(&pool)
        .await
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("importing"));

    // окончательный провал
    jobs::fail(&pool, job, "w", "fatal", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("failed"));

    // ручной повтор: упавшая задача снова в очереди
    jobs::retry(&pool, job, 0).await.unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("queued"));

    // успех
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::complete(&pool, job, "w").await.unwrap();
    assert_eq!(state_of(&pool, id).await, None);

    // и дельта синхронизации несёт значение (в снимке — тоже: поле читается из той же строки)
    let (mut tx, _) = sync::begin_snapshot(&pool).await.unwrap();
    use futures::StreamExt;
    let all: Vec<_> = sync::artists(&mut tx).collect().await;
    assert_eq!(all[0].as_ref().unwrap().import_state, None);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn import_heartbeat_does_not_bump_artist(pool: PgPool) {
    let id = artist(&pool).await;
    let job = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: id },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let before = stamp(&pool, id).await;

    assert!(jobs::heartbeat(&pool, job, "w").await.unwrap());
    let mut progress = ImportProgress::new();
    progress.done = 3;
    progress.total = 10;
    jobs::set_import_progress(&pool, id, &progress)
        .await
        .unwrap();
    // повторная запись того же состояния (например, повторная постановка активной задачи)
    sqlx::query("UPDATE jobs SET updated_at = now(), last_error = 'x' WHERE id = $1")
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(stamp(&pool, id).await, before, "артист не тронут");
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("importing"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn purging_the_latest_job_restores_the_previous_state(pool: PgPool) {
    let id = artist(&pool).await;
    let failed = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: id },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::fail(&pool, failed, "w", "fatal", None, false)
        .await
        .unwrap();
    assert_eq!(state_of(&pool, id).await.as_deref(), Some("failed"));
    // более новая задача — другая строка (в коде они разделены ключом дедупликации)
    sqlx::query(
        "INSERT INTO jobs (kind, payload, state) VALUES ('import_artist', jsonb_build_object('artist_id', $1::bigint), 'done')",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(state_of(&pool, id).await, None);
    sqlx::query("DELETE FROM jobs WHERE state = 'done'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        state_of(&pool, id).await.as_deref(),
        Some("failed"),
        "как в `ARTIST_SELECT`: последняя из оставшихся"
    );
}
