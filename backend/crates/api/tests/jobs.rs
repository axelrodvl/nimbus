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
    jobs::fail(pool, b, "w", "boom", None, true)
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
    assert_eq!(first["fatal"], false);

    let (_, v) = get_json(app.clone(), "/api/jobs?state=failed").await;
    let jobs = v["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["id"], b);
    assert_eq!(jobs[0]["last_error"], "boom");
    assert_eq!(jobs[0]["fatal"], true);
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

/// Артист в библиотеке без альбомов и без задачи импорта — нарушение I12.
async fn orphan_artist(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO artists (mbid, name, in_library, added_at)
         VALUES (gen_random_uuid(), 'Lost', TRUE, now() - interval '2 hours') RETURNING id",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invariants_report_is_empty_on_a_healthy_database(pool: PgPool) {
    seed(&pool).await;
    let (code, v) = get_json(router(state(pool)), "/api/jobs/invariants").await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["total"], 0);
    assert_eq!(v["grace_secs"], 1800);
    assert!(v["sections"].as_array().unwrap().is_empty());
    assert!(v["checked_at"].is_string());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invariants_report_lists_violations_and_feeds_health(pool: PgPool) {
    let artist_id = orphan_artist(&pool).await;
    let st = state(pool);
    let (_, h) = get_json(router(st.clone()), "/api/health").await;
    assert_eq!(h["stuck"], 0, "до первой проверки");

    let (code, v) = get_json(router(st.clone()), "/api/jobs/invariants").await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["total"], 1);
    let section = &v["sections"][0];
    assert_eq!(section["invariant"], "I12");
    assert_eq!(section["count"], 1);
    assert_eq!(
        section["violations"][0],
        serde_json::json!({"invariant": "I12", "entity": "artist", "id": artist_id, "detail": "Lost"})
    );

    // Проверка с обычной отсрочкой обновляет счётчик в health.
    let (_, h) = get_json(router(st.clone()), "/api/health").await;
    assert_eq!(h["stuck"], 1);

    // Отсрочка больше возраста состояния: нарушения нет, а счётчик health не трогается.
    let (code, v) = get_json(router(st.clone()), "/api/jobs/invariants?grace_secs=86400").await;
    assert_eq!(code, 200);
    assert_eq!(v["total"], 0);
    let (_, h) = get_json(router(st), "/api/health").await;
    assert_eq!(h["stuck"], 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invariants_grace_out_of_range_is_400(pool: PgPool) {
    let (code, v) = get_json(router(state(pool)), "/api/jobs/invariants?grace_secs=86401").await;
    assert_eq!(code, 400, "{v}");
    assert_eq!(v["error"]["code"], "invalid_grace");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invariants_require_a_token_when_auth_is_on(pool: PgPool) {
    let mut st = state(pool);
    let mut config = (*st.config).clone();
    config.api_token = Some("secret".into());
    st.config = std::sync::Arc::new(config);
    let (code, _) = get_json(router(st), "/api/jobs/invariants").await;
    assert_eq!(code, 401);
}
