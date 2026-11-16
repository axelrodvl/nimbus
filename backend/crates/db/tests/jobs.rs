// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::time::Duration;

use chrono::Utc;
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use sqlx::PgPool;

const KINDS: &[&str] = &["discover_album", "discover_artist", "verify_torrent"];

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn dedup_while_active_then_allowed_after_complete(pool: PgPool) {
    let job = Job::DiscoverAlbum { album_id: 42 };
    let id = jobs::enqueue(&pool, &job, EnqueueOpts::default())
        .await
        .unwrap()
        .expect("first enqueue");
    assert!(
        jobs::enqueue(&pool, &job, EnqueueOpts::default())
            .await
            .unwrap()
            .is_none(),
        "queued → no-op"
    );

    let row = jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(row.id, id);
    assert_eq!(row.job().unwrap(), job);
    assert_eq!(row.kind, "discover_album");
    assert!(
        jobs::enqueue(&pool, &job, EnqueueOpts::default())
            .await
            .unwrap()
            .is_none(),
        "running → no-op"
    );

    assert!(jobs::complete(&pool, id, "w").await.unwrap());
    let id2 = jobs::enqueue(&pool, &job, EnqueueOpts::default())
        .await
        .unwrap()
        .expect("after done");
    assert_ne!(id, id2);
    // другая задача того же вида — независима
    assert!(jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 43 },
        EnqueueOpts::default()
    )
    .await
    .unwrap()
    .is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn concurrent_claims_get_distinct_jobs(pool: PgPool) {
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
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
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 2 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 3 },
        EnqueueOpts::default(),
    )
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
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::at(future),
    )
    .await
    .unwrap();
    jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: 1,
            album_id: 1,
        },
        EnqueueOpts::default(),
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
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    sqlx::query("UPDATE jobs SET max_attempts = 2")
        .execute(&pool)
        .await
        .unwrap();

    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let retry_at = Utc::now() + chrono::Duration::minutes(5);
    let row = jobs::fail(&pool, id, "w", "boom", Some(retry_at))
        .await
        .unwrap()
        .unwrap();
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
    let row = jobs::fail(&pool, id, "w", "boom again", Some(retry_at))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "failed", "попытки исчерпаны");

    // без retry_at — сразу failed
    let id2 = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 2 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::fail(&pool, id2, "w", "fatal", None)
            .await
            .unwrap()
            .unwrap()
            .state,
        "failed"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn requeue_stale_and_purge(pool: PgPool) {
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let out = jobs::requeue_stale(&pool, Duration::from_secs(600))
        .await
        .unwrap();
    assert_eq!(
        (out.requeued, out.failed.len()),
        (0, 0),
        "свежая не трогается"
    );
    sqlx::query("UPDATE jobs SET heartbeat_at = now() - interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    let out = jobs::requeue_stale(&pool, Duration::from_secs(600))
        .await
        .unwrap();
    assert_eq!((out.requeued, out.failed.len()), (1, 0));
    let again = jobs::claim(&pool, "w2", KINDS).await.unwrap().unwrap();
    assert_eq!(again.id, id);
    assert_eq!(again.locked_by.as_deref(), Some("w2"));

    assert!(jobs::complete(&pool, id, "w2").await.unwrap());
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
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts {
            run_after: None,
            max_attempts: Some(1),
            ..EnqueueOpts::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    sqlx::query("UPDATE jobs SET heartbeat_at = now() - interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    let out = jobs::requeue_stale(&pool, Duration::from_secs(600))
        .await
        .unwrap();
    assert_eq!(out.requeued, 0);
    assert_eq!(
        out.failed.iter().map(|r| r.id).collect::<Vec<_>>(),
        [id],
        "исчерпавшая попытки возвращается для on_exhausted"
    );
    assert!(jobs::claim(&pool, "w2", KINDS).await.unwrap().is_none());
    let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "failed");
}

async fn enq(pool: &PgPool, album_id: i64, opts: EnqueueOpts) -> Option<i64> {
    jobs::enqueue(pool, &Job::DiscoverAlbum { album_id }, opts)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn claim_orders_by_priority_then_run_after(pool: PgPool) {
    let past = Utc::now() - chrono::Duration::minutes(10);
    let old_normal = enq(&pool, 1, EnqueueOpts::at(past)).await.unwrap();
    let bg = enq(&pool, 2, EnqueueOpts::priority(-10)).await.unwrap();
    let hi = enq(&pool, 3, EnqueueOpts::priority(10)).await.unwrap();
    let normal = enq(&pool, 4, EnqueueOpts::default()).await.unwrap();
    let mut order = vec![];
    while let Some(j) = jobs::claim(&pool, "w", KINDS).await.unwrap() {
        order.push(j.id);
    }
    assert_eq!(order, [hi, old_normal, normal, bg]);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn enqueue_with_higher_priority_bumps_queued_duplicate(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::priority(-10)).await.unwrap();
    assert!(enq(&pool, 1, EnqueueOpts::priority(10)).await.is_none());
    let row = &jobs::list(&pool, None, 10).await.unwrap()[0];
    assert_eq!((row.id, row.priority), (id, 10));
    // Меньший приоритет существующий не понижает.
    assert!(enq(&pool, 1, EnqueueOpts::priority(0)).await.is_none());
    assert_eq!(jobs::list(&pool, None, 10).await.unwrap()[0].priority, 10);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn enqueue_does_not_bump_running_duplicate(pool: PgPool) {
    enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert!(enq(&pool, 1, EnqueueOpts::priority(10)).await.is_none());
    assert_eq!(jobs::list(&pool, None, 10).await.unwrap()[0].priority, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn heartbeat_keeps_job_fresh_and_only_for_owner(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    sqlx::query("UPDATE jobs SET heartbeat_at = now() - interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!jobs::heartbeat(&pool, id, "other").await.unwrap());
    assert!(jobs::heartbeat(&pool, id, "w").await.unwrap());
    let out = jobs::requeue_stale(&pool, Duration::from_secs(600))
        .await
        .unwrap();
    assert_eq!(out.requeued, 0, "свежий heartbeat держит задачу");
    assert!(jobs::complete(&pool, id, "w").await.unwrap());
    assert!(
        !jobs::heartbeat(&pool, id, "w").await.unwrap(),
        "завершённую строку heartbeat не оживляет"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn recover_orphans_requeues_running_and_returns_the_attempt(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    let other = enq(&pool, 2, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(jobs::recover_orphans(&pool).await.unwrap(), 1);
    let rows = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(rows.len(), 2);
    let r = rows.iter().find(|r| r.id == id).unwrap();
    assert_eq!((r.attempts, r.locked_by.clone()), (0, None));
    assert!(rows.iter().any(|r| r.id == other));
    // Без running — ничего не делает, попытки не уходят в минус.
    assert_eq!(jobs::recover_orphans(&pool).await.unwrap(), 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn release_workers_touches_only_listed_workers(pool: PgPool) {
    enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    enq(&pool, 2, EnqueueOpts::default()).await.unwrap();
    let a = jobs::claim(&pool, "a", KINDS).await.unwrap().unwrap();
    let b = jobs::claim(&pool, "b", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::release_workers(&pool, &["a".to_string()])
            .await
            .unwrap(),
        1
    );
    let rows = jobs::list(&pool, None, 10).await.unwrap();
    let get = |id| rows.iter().find(|r| r.id == id).unwrap();
    assert_eq!(
        (get(a.id).state.as_str(), get(a.id).attempts),
        ("queued", 0)
    );
    assert_eq!(get(b.id).state, "running");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn release_returns_single_job_without_spending_attempt(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert!(jobs::release(&pool, id, "w").await.unwrap());
    let r = &jobs::list(&pool, None, 10).await.unwrap()[0];
    assert_eq!((r.state.as_str(), r.attempts), ("queued", 0));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn demote_queued_verifies_lowers_priority_of_that_album_only(pool: PgPool) {
    let verify = |t, a| Job::VerifyTorrent {
        torrent_id: t,
        album_id: a,
    };
    for (t, a) in [(1, 7), (2, 7), (3, 8)] {
        jobs::enqueue(&pool, &verify(t, a), EnqueueOpts::priority(10))
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(
        jobs::demote_queued_verifies(&pool, 7, -10).await.unwrap(),
        2
    );
    let mut prio: Vec<(String, i16)> = jobs::list(&pool, None, 10)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.payload["torrent_id"].to_string(), r.priority))
        .collect();
    prio.sort();
    assert_eq!(
        prio,
        [("1".into(), -10), ("2".into(), -10), ("3".into(), 10)]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_requeues_only_failed_jobs(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    assert!(matches!(
        jobs::retry(&pool, id, 10).await.unwrap(),
        jobs::RetryOutcome::NotFailed
    ));
    assert!(matches!(
        jobs::retry(&pool, 9999, 10).await.unwrap(),
        jobs::RetryOutcome::NotFound
    ));
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::fail(&pool, id, "w", "boom", None)
        .await
        .unwrap()
        .unwrap();
    match jobs::retry(&pool, id, 10).await.unwrap() {
        jobs::RetryOutcome::Queued(r) => {
            assert_eq!(
                (r.state.as_str(), r.attempts, r.priority),
                ("queued", 0, 10)
            );
        }
        other => panic!("{other:?}"),
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_conflicts_with_active_duplicate(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::fail(&pool, id, "w", "boom", None)
        .await
        .unwrap()
        .unwrap();
    enq(&pool, 1, EnqueueOpts::default()).await.unwrap(); // новая активная
    assert!(matches!(
        jobs::retry(&pool, id, 10).await.unwrap(),
        jobs::RetryOutcome::Duplicate
    ));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn counts_and_filtered_list(pool: PgPool) {
    enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    let b = enq(&pool, 2, EnqueueOpts::default()).await.unwrap();
    jobs::enqueue(
        &pool,
        &Job::DiscoverArtist { artist_id: 5 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    jobs::claim(&pool, "w", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    let c = jobs::claim(&pool, "w", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(c.id, b);
    jobs::fail(&pool, b, "w", "x", None).await.unwrap().unwrap();
    let counts = jobs::counts(&pool).await.unwrap();
    assert_eq!((counts.queued, counts.running, counts.failed), (1, 1, 1));
    let only_artist = jobs::list_filtered(&pool, None, Some("discover_artist"), 10)
        .await
        .unwrap();
    assert_eq!(only_artist.len(), 1);
    let failed = jobs::list_filtered(&pool, Some("failed"), None, 10)
        .await
        .unwrap();
    assert_eq!(failed.len(), 1);
}

/// A взял задачу, `requeue_stale(0)` вернул её, B взял снова: A «оживает» и пытается записать итог.
async fn taken_over(pool: &PgPool) -> i64 {
    let id = enq(pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(pool, "A", KINDS).await.unwrap().unwrap();
    let out = jobs::requeue_stale(pool, Duration::ZERO).await.unwrap();
    assert_eq!(out.requeued, 1);
    let row = jobs::claim(pool, "B", KINDS).await.unwrap().unwrap();
    assert_eq!(row.id, id);
    id
}

async fn assert_running_by_b(pool: &PgPool, id: i64) {
    let r = jobs::list(pool, None, 10)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    assert_eq!(
        (r.state.as_str(), r.locked_by.as_deref(), r.attempts),
        ("running", Some("B"), 2)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn complete_by_lost_worker_is_ignored(pool: PgPool) {
    let id = taken_over(&pool).await;
    assert!(!jobs::complete(&pool, id, "A").await.unwrap());
    assert_running_by_b(&pool, id).await;
    assert!(jobs::complete(&pool, id, "B").await.unwrap());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fail_by_lost_worker_is_ignored(pool: PgPool) {
    let id = taken_over(&pool).await;
    let retry = Some(Utc::now());
    assert!(jobs::fail(&pool, id, "A", "x", retry)
        .await
        .unwrap()
        .is_none());
    assert_running_by_b(&pool, id).await;
    assert!(jobs::fail(&pool, id, "B", "x", retry)
        .await
        .unwrap()
        .is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn defer_by_lost_worker_is_ignored(pool: PgPool) {
    let id = taken_over(&pool).await;
    let at = Utc::now();
    let age = Duration::from_secs(3600);
    assert!(jobs::defer(&pool, id, "A", "x", at, age)
        .await
        .unwrap()
        .is_none());
    assert_running_by_b(&pool, id).await;
    assert!(jobs::defer(&pool, id, "B", "x", at, age)
        .await
        .unwrap()
        .is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn release_by_lost_worker_is_ignored(pool: PgPool) {
    let id = taken_over(&pool).await;
    assert!(!jobs::release(&pool, id, "A").await.unwrap());
    assert_running_by_b(&pool, id).await;
    assert!(jobs::release(&pool, id, "B").await.unwrap());
}
