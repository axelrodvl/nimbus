// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{get_json, request_json, router, state};
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use sqlx::PgPool;

async fn seed(pool: &PgPool) -> (i64, i64, i64) {
    let a = jobs::enqueue(
        pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let b = jobs::enqueue(
        pool,
        &Job::DiscoverAlbum { album_id: 2 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let c = jobs::enqueue(
        pool,
        &Job::DiscoverArtist { artist_id: 5 },
        EnqueueOpts::priority(10),
    )
    .await
    .unwrap()
    .unwrap();
    // a — running, b — failed, c — queued
    jobs::claim(pool, "w", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    jobs::claim(pool, "w", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    jobs::fail(pool, b, "w", "boom", None)
        .await
        .unwrap()
        .unwrap();
    (a, b, c)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn lists_jobs_with_counts_and_filters(pool: PgPool) {
    let (a, b, c) = seed(&pool).await;
    let app = router(state(pool));

    let (code, v) = get_json(app.clone(), "/api/jobs").await;
    assert_eq!(code, 200);
    assert_eq!(v["jobs"].as_array().unwrap().len(), 3);
    assert_eq!(
        v["counts"],
        serde_json::json!({"queued": 1, "running": 1, "failed": 1})
    );
    let first = &v["jobs"][0];
    assert_eq!(first["id"], c, "новые первыми");
    assert_eq!(first["priority"], 10);
    assert_eq!(first["kind"], "discover_artist");
    assert_eq!(first["payload"]["artist_id"], 5);

    let (_, v) = get_json(app.clone(), "/api/jobs?state=failed").await;
    let jobs = v["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["id"], b);
    assert_eq!(jobs[0]["last_error"], "boom");
    assert_eq!(jobs[0]["attempts"], 1);
    assert_eq!(jobs[0]["max_attempts"], 5);
    assert_eq!(v["counts"]["queued"], 1, "счётчики не зависят от фильтра");

    let (_, v) = get_json(app.clone(), "/api/jobs?kind=discover_album").await;
    let ids: Vec<i64> = v["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [b, a]);

    let (_, v) = get_json(app.clone(), "/api/jobs?limit=1").await;
    assert_eq!(v["jobs"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unknown_state_is_a_400(pool: PgPool) {
    let app = router(state(pool));
    let (code, v) = get_json(app, "/api/jobs?state=bogus").await;
    assert_eq!(code, 400);
    assert_eq!(v["error"]["code"], "invalid_state");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_requeues_a_failed_job_with_interactive_priority(pool: PgPool) {
    let (_, b, _) = seed(&pool).await;
    let app = router(state(pool.clone()));
    let (code, v) = request_json(app.clone(), "POST", &format!("/api/jobs/{b}/retry"), None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["state"], "queued");
    assert_eq!(v["attempts"], 0);
    assert_eq!(v["priority"], 10);
    let (_, list) = get_json(app, "/api/jobs?state=failed").await;
    assert!(list["jobs"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_of_a_non_failed_job_is_409(pool: PgPool) {
    let (a, _, c) = seed(&pool).await;
    let app = router(state(pool));
    for id in [a, c] {
        let (code, v) =
            request_json(app.clone(), "POST", &format!("/api/jobs/{id}/retry"), None).await;
        assert_eq!(code, 409, "{v}");
        assert_eq!(v["error"]["code"], "not_failed");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_with_active_duplicate_is_409(pool: PgPool) {
    let (_, b, _) = seed(&pool).await;
    // Пока `b` в failed, поставили такую же задачу заново.
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 2 },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let app = router(state(pool));
    let (code, v) = request_json(app, "POST", &format!("/api/jobs/{b}/retry"), None).await;
    assert_eq!(code, 409, "{v}");
    assert_eq!(v["error"]["code"], "duplicate");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_of_a_missing_job_is_404(pool: PgPool) {
    let app = router(state(pool));
    let (code, _) = request_json(app, "POST", "/api/jobs/9999/retry", None).await;
    assert_eq!(code, 404);
}
