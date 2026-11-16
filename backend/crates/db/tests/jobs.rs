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
        "running → строка не создаётся (выставляется rerun)"
    );

    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Requeued
    );
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Done
    );
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
    let row = jobs::fail(&pool, id, "w", "boom", Some(retry_at), false)
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
    let row = jobs::fail(&pool, id, "w", "boom again", Some(retry_at), false)
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
        jobs::fail(&pool, id2, "w", "fatal", None, false)
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

    assert_eq!(
        jobs::complete(&pool, id, "w2").await.unwrap(),
        jobs::Completion::Done
    );
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
async fn enqueue_bumps_running_duplicate_priority_for_the_rerun(pool: PgPool) {
    enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert!(enq(&pool, 1, EnqueueOpts::priority(10)).await.is_none());
    assert_eq!(jobs::list(&pool, None, 10).await.unwrap()[0].priority, 10);
    // Меньший приоритет не понижает.
    assert!(enq(&pool, 1, EnqueueOpts::priority(0)).await.is_none());
    assert_eq!(jobs::list(&pool, None, 10).await.unwrap()[0].priority, 10);
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
    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Done
    );
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
    assert_eq!(jobs::recover_orphans(&pool, 3).await.unwrap().requeued, 1);
    let rows = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert_eq!(rows.len(), 2);
    let r = rows.iter().find(|r| r.id == id).unwrap();
    assert_eq!((r.attempts, r.locked_by.clone()), (0, None));
    assert!(rows.iter().any(|r| r.id == other));
    // Без running — ничего не делает, попытки не уходят в минус.
    assert_eq!(jobs::recover_orphans(&pool, 3).await.unwrap().requeued, 0);
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
    jobs::fail(&pool, id, "w", "boom", None, false)
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
    jobs::fail(&pool, id, "w", "boom", None, false)
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
    jobs::fail(&pool, b, "w", "x", None, false)
        .await
        .unwrap()
        .unwrap();
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
    assert_eq!(
        jobs::complete(&pool, id, "A").await.unwrap(),
        jobs::Completion::Lost
    );
    assert_running_by_b(&pool, id).await;
    assert_eq!(
        jobs::complete(&pool, id, "B").await.unwrap(),
        jobs::Completion::Done
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fail_by_lost_worker_is_ignored(pool: PgPool) {
    let id = taken_over(&pool).await;
    let retry = Some(Utc::now());
    assert!(jobs::fail(&pool, id, "A", "x", retry, false)
        .await
        .unwrap()
        .is_none());
    assert_running_by_b(&pool, id).await;
    assert!(jobs::fail(&pool, id, "B", "x", retry, false)
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

async fn job_row(pool: &PgPool, id: i64) -> jobs::JobRow {
    jobs::list(pool, None, 50)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap()
}

/// Ставит и забирает задачу; повторный запрос во время выполнения (дедупликация → `rerun`).
async fn running_with_request(pool: &PgPool) -> i64 {
    let id = enq(pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(pool, "w", KINDS).await.unwrap().unwrap();
    assert!(
        enq(pool, 1, EnqueueOpts::priority(7)).await.is_none(),
        "новая строка не создаётся"
    );
    id
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn enqueue_during_running_sets_rerun(pool: PgPool) {
    let id = running_with_request(&pool).await;
    let r = job_row(&pool, id).await;
    assert_eq!(
        (r.state.as_str(), r.rerun, r.priority),
        ("running", true, 7)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn enqueue_during_queued_does_not_set_rerun(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    assert!(enq(&pool, 1, EnqueueOpts::default()).await.is_none());
    assert!(!job_row(&pool, id).await.rerun);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn complete_with_rerun_requeues_with_fresh_attempts_and_notifies(pool: PgPool) {
    let mut listener = sqlx::postgres::PgListener::connect_with(&pool)
        .await
        .unwrap();
    listener.listen(jobs::NOTIFY_CHANNEL).await.unwrap();
    let id = running_with_request(&pool).await;
    // уведомление о первой постановке
    listener.recv().await.unwrap();
    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Requeued
    );
    let r = job_row(&pool, id).await;
    assert_eq!(
        (r.state.as_str(), r.attempts, r.rerun, r.locked_by),
        ("queued", 0, false, None)
    );
    let n = tokio::time::timeout(Duration::from_secs(5), listener.recv())
        .await
        .expect("NOTIFY при повторной постановке")
        .unwrap();
    assert_eq!(n.payload(), id.to_string());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn rerun_is_cleared_after_requeue(pool: PgPool) {
    let id = running_with_request(&pool).await;
    jobs::complete(&pool, id, "w").await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Done
    );
    assert_eq!(job_row(&pool, id).await.state, "done");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn final_failure_with_rerun_requeues(pool: PgPool) {
    let id = running_with_request(&pool).await;
    let row = jobs::fail(&pool, id, "w", "boom", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (row.state.as_str(), row.attempts, row.rerun),
        ("queued", 0, false)
    );
    // без rerun тот же провал окончателен
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let row = jobs::fail(&pool, id, "w", "boom", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "failed");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retryable_failure_with_rerun_keeps_backoff_but_clears_flag(pool: PgPool) {
    let id = running_with_request(&pool).await;
    let at = Utc::now() + chrono::Duration::minutes(5);
    let row = jobs::fail(&pool, id, "w", "boom", Some(at), false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (row.state.as_str(), row.attempts, row.rerun),
        ("queued", 1, false)
    );
    assert!(row.run_after > Utc::now() + chrono::Duration::minutes(4));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn aged_defer_with_rerun_requeues_instead_of_failing(pool: PgPool) {
    let id = running_with_request(&pool).await;
    sqlx::query("UPDATE jobs SET deferred_since = now() - interval '2 days'")
        .execute(&pool)
        .await
        .unwrap();
    let age = Duration::from_secs(3600);
    let row = jobs::defer(
        &pool,
        id,
        "w",
        "x",
        Utc::now() + chrono::Duration::hours(1),
        age,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        (row.state.as_str(), row.attempts, row.rerun),
        ("queued", 0, false)
    );
    assert!(row.run_after <= Utc::now());
    // без rerun — по-прежнему failed
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    sqlx::query("UPDATE jobs SET deferred_since = now() - interval '2 days'")
        .execute(&pool)
        .await
        .unwrap();
    let row = jobs::defer(&pool, id, "w", "x", Utc::now(), age)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "failed");
}

async fn deferred_since(pool: &PgPool, id: i64) -> Option<chrono::DateTime<Utc>> {
    sqlx::query_scalar("SELECT deferred_since FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn defer_age_counts_from_first_defer(pool: PgPool) {
    // Задача давно в очереди (created_at старый), но ни разу не откладывалась: первый Defer — `queued`.
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    sqlx::query("UPDATE jobs SET created_at = now() - interval '2 days'")
        .execute(&pool)
        .await
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    assert!(deferred_since(&pool, id).await.is_none());
    let age = Duration::from_secs(3600);
    let row = jobs::defer(&pool, id, "w", "x", Utc::now(), age)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "queued");
    let first = deferred_since(&pool, id).await.unwrap();
    // Повторный Defer метку не сдвигает.
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::defer(&pool, id, "w", "x", Utc::now(), age)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deferred_since(&pool, id).await, Some(first));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn defer_expires_after_max_age_since_first_defer(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let age = Duration::from_secs(3600);
    jobs::defer(&pool, id, "w", "x", Utc::now(), age)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET deferred_since = now() - interval '2 hours', run_after = now()")
        .execute(&pool)
        .await
        .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let row = jobs::defer(&pool, id, "w", "x", Utc::now(), age)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "failed");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn complete_fail_and_retry_clear_deferred_since(pool: PgPool) {
    let age = Duration::from_secs(3600);
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    for finish in 0..3 {
        jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
        jobs::defer(&pool, id, "w", "x", Utc::now(), age)
            .await
            .unwrap()
            .unwrap();
        assert!(deferred_since(&pool, id).await.is_some());
        jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
        match finish {
            0 => {
                jobs::complete(&pool, id, "w").await.unwrap();
            }
            1 => {
                jobs::fail(&pool, id, "w", "boom", None, false)
                    .await
                    .unwrap()
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(deferred_since(&pool, id).await.is_none(), "after {finish}");
        if finish == 0 {
            // `done` — заново ставим для следующего круга.
            sqlx::query("UPDATE jobs SET state = 'queued', run_after = now()")
                .execute(&pool)
                .await
                .unwrap();
        } else {
            break;
        }
    }
    // retry после failed
    sqlx::query("UPDATE jobs SET deferred_since = now()")
        .execute(&pool)
        .await
        .unwrap();
    jobs::retry(&pool, id, 0).await.unwrap();
    assert!(deferred_since(&pool, id).await.is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn release_and_stale_requeue_clear_rerun(pool: PgPool) {
    let id = running_with_request(&pool).await;
    assert!(jobs::release(&pool, id, "w").await.unwrap());
    assert!(!job_row(&pool, id).await.rerun);
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    enq(&pool, 1, EnqueueOpts::default()).await;
    jobs::requeue_stale(&pool, Duration::ZERO).await.unwrap();
    assert!(!job_row(&pool, id).await.rerun);
}

// ---- B05: оживление упавших задач ----

const REVIVE_KINDS: &[&str] = &["import_artist", "discover_artist"];
const REVIVE_DELAYS: &[Duration] = &[
    Duration::from_secs(900),
    Duration::from_secs(3600),
    Duration::from_secs(6 * 3600),
];

/// Ставит `import_artist` артиста, берёт и проваливает его (`fatal` — окончательно).
async fn failed_import(pool: &PgPool, artist_id: i64, fatal: bool) -> i64 {
    let id = jobs::enqueue(
        pool,
        &Job::ImportArtist { artist_id },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(pool, "w", REVIVE_KINDS).await.unwrap().unwrap();
    let row = jobs::fail(pool, id, "w", "mb down", None, fatal)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "failed");
    id
}

async fn age(pool: &PgPool, id: i64, interval: &str) {
    sqlx::query("UPDATE jobs SET updated_at = now() - $2::interval WHERE id = $1")
        .bind(id)
        .bind(interval)
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_failed_requeues_after_delay(pool: PgPool) {
    let id = failed_import(&pool, 1, false).await;
    age(&pool, id, "14 minutes").await;
    assert!(jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap()
        .is_empty());

    age(&pool, id, "16 minutes").await;
    let rows = jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    let r = job_row(&pool, id).await;
    assert_eq!((r.state.as_str(), r.attempts, r.revivals), ("queued", 0, 1));
    assert!(r.priority <= 0);
    assert!(jobs::claim(&pool, "w", REVIVE_KINDS)
        .await
        .unwrap()
        .is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_delay_grows_with_revivals_and_last_repeats(pool: PgPool) {
    let id = failed_import(&pool, 1, false).await;
    sqlx::query("UPDATE jobs SET revivals = 1 WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    age(&pool, id, "30 minutes").await;
    assert!(
        jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
            .await
            .unwrap()
            .is_empty(),
        "после первого оживления пауза — час"
    );
    age(&pool, id, "61 minutes").await;
    assert_eq!(
        jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
            .await
            .unwrap()
            .len(),
        1
    );

    // revivals больше длины массива: берётся последнее значение (6 ч)
    jobs::claim(&pool, "w", REVIVE_KINDS)
        .await
        .unwrap()
        .unwrap();
    jobs::fail(&pool, id, "w", "again", None, false)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET revivals = 10 WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    age(&pool, id, "5 hours").await;
    assert!(jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap()
        .is_empty());
    age(&pool, id, "7 hours").await;
    assert_eq!(
        jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_skips_fatal(pool: PgPool) {
    let id = failed_import(&pool, 1, true).await;
    assert!(job_row(&pool, id).await.fatal);
    age(&pool, id, "30 days").await;
    assert!(jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_skips_other_kinds(pool: PgPool) {
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::fail(&pool, id, "w", "x", None, false)
        .await
        .unwrap()
        .unwrap();
    age(&pool, id, "30 days").await;
    assert!(jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(job_row(&pool, id).await.state, "failed");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_skips_when_active_duplicate_exists(pool: PgPool) {
    let id = failed_import(&pool, 1, false).await;
    age(&pool, id, "30 days").await;
    let newer = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(job_row(&pool, id).await.state, "failed");
    assert_eq!(job_row(&pool, newer).await.state, "queued");
}

/// Упавший импорт заменён новой успешной задачей (ручной повтор). Когда уборка удаляет её `done`,
/// старая `failed` не должна снова стать «последней» и ожить неделю спустя.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn purged_done_does_not_resurrect_superseded_failure(pool: PgPool) {
    let old = failed_import(&pool, 1, false).await;
    let other = failed_import(&pool, 2, false).await;
    let newer = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", REVIVE_KINDS)
        .await
        .unwrap()
        .unwrap();
    jobs::complete(&pool, newer, "w").await.unwrap();
    // Свежая `done` ещё хранится — старую `failed` уборка не трогает.
    assert_eq!(
        jobs::purge_done(&pool, Duration::from_secs(7 * 86400))
            .await
            .unwrap(),
        0
    );
    for id in [old, other, newer] {
        age(&pool, id, "8 days").await;
    }
    assert_eq!(
        jobs::purge_done(&pool, Duration::from_secs(7 * 86400))
            .await
            .unwrap(),
        2,
        "done и вытесненная ею failed"
    );
    let rows = jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        [other],
        "оживает только задача без успешной замены"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_takes_only_latest_of_same_key(pool: PgPool) {
    let old = failed_import(&pool, 1, false).await;
    let newer = failed_import(&pool, 1, false).await;
    age(&pool, old, "30 days").await;
    age(&pool, newer, "30 days").await;
    let rows = jobs::revive_failed(&pool, REVIVE_KINDS, REVIVE_DELAYS)
        .await
        .unwrap();
    assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), [newer]);
    assert_eq!(job_row(&pool, old).await.state, "failed");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fail_sets_fatal_only_on_final_failure(pool: PgPool) {
    let id = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", REVIVE_KINDS)
        .await
        .unwrap()
        .unwrap();
    // повтор запланирован: задача не провалена, `fatal` не записывается
    let row = jobs::fail(&pool, id, "w", "x", Some(Utc::now()), true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((row.state.as_str(), row.fatal), ("queued", false));

    jobs::claim(&pool, "w", REVIVE_KINDS)
        .await
        .unwrap()
        .unwrap();
    let row = jobs::fail(&pool, id, "w", "x", None, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((row.state.as_str(), row.fatal), ("failed", true));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn manual_retry_clears_fatal_and_revivals(pool: PgPool) {
    let id = failed_import(&pool, 1, true).await;
    sqlx::query("UPDATE jobs SET revivals = 3 WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        jobs::retry(&pool, id, 10).await.unwrap(),
        jobs::RetryOutcome::Queued(_)
    ));
    let r = job_row(&pool, id).await;
    assert_eq!((r.fatal, r.revivals), (false, 0));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn purge_removes_old_fatal_and_superseded_failed(pool: PgPool) {
    let fatal_old = failed_import(&pool, 1, true).await;
    let superseded = failed_import(&pool, 2, false).await;
    let latest = failed_import(&pool, 2, false).await;
    let fatal_fresh = failed_import(&pool, 3, true).await;
    let lone = failed_import(&pool, 4, false).await;
    for id in [fatal_old, superseded, latest, lone] {
        age(&pool, id, "31 days").await;
    }
    let n = jobs::purge_failed(&pool, Duration::from_secs(30 * 86400))
        .await
        .unwrap();
    assert_eq!(n, 2);
    let left: Vec<i64> = jobs::list(&pool, None, 50)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert!(!left.contains(&fatal_old) && !left.contains(&superseded));
    assert!(left.contains(&latest) && left.contains(&fatal_fresh) && left.contains(&lone));
}

/// Повторный запрос на ожидающую задачу из незакоммиченной транзакции: воркер не должен взять
/// задачу, пока данные запроса не видны (иначе обработчик прочитал бы состояние без них).
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn queued_job_is_not_claimed_until_the_requesting_transaction_commits(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(
        jobs::enqueue(
            &mut *tx,
            &Job::DiscoverAlbum { album_id: 1 },
            EnqueueOpts::default()
        )
        .await
        .unwrap(),
        None
    );
    assert!(
        jobs::claim(&pool, "w", KINDS).await.unwrap().is_none(),
        "запрос ещё не закоммичен"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap().id,
        id
    );
}

/// Выполняющаяся задача не завершается, пока транзакция с повторным запросом не закоммичена;
/// после коммита она видит `rerun` и ставится заново.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn running_job_completes_only_after_the_requesting_transaction(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let mut tx = pool.begin().await.unwrap();
    jobs::enqueue(
        &mut *tx,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let p = pool.clone();
    let done = tokio::spawn(async move { jobs::complete(&p, id, "w").await.unwrap() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!done.is_finished(), "complete ждёт коммита запроса");
    tx.commit().await.unwrap();
    assert_eq!(done.await.unwrap(), jobs::Completion::Requeued);
}

/// Ключ свободен (прежняя задача завершена) — ставится новая строка; откат транзакции запроса
/// не оставляет следов на активной задаче.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn rolled_back_request_leaves_running_job_untouched(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let mut tx = pool.begin().await.unwrap();
    jobs::enqueue(
        &mut *tx,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        jobs::complete(&pool, id, "w").await.unwrap(),
        jobs::Completion::Done
    );
    assert!(enq(&pool, 1, EnqueueOpts::default()).await.is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn recover_orphans_counts_crashes_and_fails_at_threshold(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    for round in 1..=2 {
        jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
        let out = jobs::recover_orphans(&pool, 3).await.unwrap();
        assert_eq!((out.requeued, out.failed.len()), (1, 0));
        let r = job_row(&pool, id).await;
        assert_eq!(
            (r.state.as_str(), r.attempts, r.crashes),
            ("queued", 0, round)
        );
    }
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    let out = jobs::recover_orphans(&pool, 3).await.unwrap();
    assert_eq!((out.requeued, out.failed.len()), (0, 1));
    let r = job_row(&pool, id).await;
    assert_eq!((r.state.as_str(), r.fatal, r.crashes), ("failed", false, 3));
    assert!(r.last_error.unwrap().contains("crashed 3 times"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn graceful_release_does_not_count_crash(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    for _ in 0..5 {
        jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
        jobs::release_workers(&pool, &["w".to_string()])
            .await
            .unwrap();
    }
    assert_eq!(job_row(&pool, id).await.crashes, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_resets_crashes(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::recover_orphans(&pool, 1).await.unwrap();
    assert_eq!(job_row(&pool, id).await.crashes, 1);
    jobs::retry(&pool, id, 0).await.unwrap();
    assert_eq!(job_row(&pool, id).await.crashes, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn revive_resets_crashes(pool: PgPool) {
    let id = enq(&pool, 1, EnqueueOpts::default()).await.unwrap();
    jobs::claim(&pool, "w", KINDS).await.unwrap().unwrap();
    jobs::recover_orphans(&pool, 1).await.unwrap();
    sqlx::query("UPDATE jobs SET updated_at = now() - interval '1 day'")
        .execute(&pool)
        .await
        .unwrap();
    let kind = job_row(&pool, id).await.kind;
    let n = jobs::revive_failed(&pool, &[kind.as_str()], &[Duration::from_secs(1)])
        .await
        .unwrap();
    assert_eq!(n.len(), 1);
    assert_eq!(job_row(&pool, id).await.crashes, 0);
}
