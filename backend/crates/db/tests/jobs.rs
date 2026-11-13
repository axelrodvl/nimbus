// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::time::Duration;

use chrono::Utc;
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs;
use sqlx::PgPool;

const KINDS: &[&str] = &["discover_album", "discover_artist", "verify_torrent"];

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn dedup_while_active_then_allowed_after_complete(pool: PgPool) {
    let job = Job::DiscoverAlbum { album_id: 42 };
    let id = jobs::enqueue(&pool, &job, None)
        .await
        .unwrap()
        .expect("first enqueue");
    assert!(
        jobs::enqueue(&pool, &job, None).await.unwrap().is_none(),
        "queued → no-op"
    );

    let row = jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(row.id, id);
    assert_eq!(row.job().unwrap(), job);
    assert_eq!(row.kind, "discover_album");
    assert!(
        jobs::enqueue(&pool, &job, None).await.unwrap().is_none(),
        "running → no-op"
    );

    jobs::complete(&pool, id).await.unwrap();
    let id2 = jobs::enqueue(&pool, &job, None)
        .await
        .unwrap()
        .expect("after done");
    assert_ne!(id, id2);
    // другая задача того же вида — независима
    assert!(
        jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 43 }, None)
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn concurrent_claims_get_distinct_jobs(pool: PgPool) {
    jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, None)
        .await
        .unwrap();
    // одна задача, много претендентов — достаётся ровно одному
    let mut set = tokio::task::JoinSet::new();
    for i in 0..8 {
        let p = pool.clone();
        set.spawn(async move { jobs::claim(&p, &format!("w{i}"), KINDS).await.unwrap() });
    }
    let mut got = 0;
    while let Some(r) = set.join_next().await {
        got += r.unwrap().is_some() as u32;
    }
    assert_eq!(got, 1);

    // две задачи — две разные
    jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 2 }, None)
        .await
        .unwrap();
    jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 3 }, None)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        jobs::claim(&pool, "a", KINDS),
        jobs::claim(&pool, "b", KINDS)
    );
    let (a, b) = (a.unwrap().unwrap(), b.unwrap().unwrap());
    assert_ne!(a.id, b.id);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn claim_respects_kind_and_run_after(pool: PgPool) {
    let future = Utc::now() + chrono::Duration::hours(1);
    jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, Some(future))
        .await
        .unwrap();
    jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: 1,
            album_id: 1,
        },
        None,
    )
    .await
    .unwrap();
    assert!(jobs::claim(&pool, "w", &["discover_album"])
        .await
        .unwrap()
        .is_none());
    let r = jobs::claim(&pool, "w", &["verify_torrent"])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.kind, "verify_torrent");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fail_retries_then_gives_up(pool: PgPool) {
    let id = jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, None)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET max_attempts = 2")
        .execute(&pool)
        .await
        .unwrap();

    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let retry_at = Utc::now() + chrono::Duration::minutes(5);
    let row = jobs::fail(&pool, id, "boom", Some(retry_at)).await.unwrap();
    assert_eq!(row.state, "queued");
    assert!(row.run_after > Utc::now() + chrono::Duration::minutes(4));
    assert_eq!(row.last_error.as_deref(), Some("boom"));
    assert!(
        jobs::claim(&pool, "w", KINDS).await.unwrap().is_none(),
        "ещё рано"
    );

    sqlx::query("UPDATE jobs SET run_after = now()")
        .execute(&pool)
        .await
        .unwrap();
    let r = jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(r.attempts, 2);
    let row = jobs::fail(&pool, id, "boom again", Some(retry_at))
        .await
        .unwrap();
    assert_eq!(row.state, "failed", "попытки исчерпаны");

    // без retry_at — сразу failed
    let id2 = jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 2 }, None)
        .await
        .unwrap()
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::fail(&pool, id2, "fatal", None).await.unwrap().state,
        "failed"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn requeue_stale_and_purge(pool: PgPool) {
    let id = jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, None)
        .await
        .unwrap()
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::requeue_stale(&pool, Duration::from_secs(600))
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE jobs SET locked_at = now() - interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        jobs::requeue_stale(&pool, Duration::from_secs(600))
            .await
            .unwrap(),
        1
    );
    let again = jobs::claim(&pool, "w2", KINDS).await.unwrap().unwrap();
    assert_eq!(again.id, id);
    assert_eq!(again.locked_by.as_deref(), Some("w2"));

    jobs::complete(&pool, id).await.unwrap();
    assert_eq!(
        jobs::purge_done(&pool, Duration::from_secs(7 * 86400))
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE jobs SET updated_at = now() - interval '8 days'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        jobs::purge_done(&pool, Duration::from_secs(7 * 86400))
            .await
            .unwrap(),
        1
    );
    assert!(jobs::list(&pool, None, 10).await.unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn requeue_stale_fails_when_attempts_exhausted(pool: PgPool) {
    let id = jobs::enqueue_with_attempts(&pool, &Job::DiscoverAlbum { album_id: 1 }, None, Some(1))
        .await
        .unwrap()
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    sqlx::query("UPDATE jobs SET locked_at = now() - interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        jobs::requeue_stale(&pool, Duration::from_secs(600))
            .await
            .unwrap(),
        1
    );
    assert!(jobs::claim(&pool, "w2", KINDS).await.unwrap().is_none());
    let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "failed");
}
