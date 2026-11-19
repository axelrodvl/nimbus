// Интеграционные тесты: unwrap допустим.
#![allow(clippy::unwrap_used)]
use nimbus_core::events::EventBus;
use nimbus_core::jobs::Job;
use nimbus_db::repo::mb_cache;
use nimbus_worker::handlers::FetchArtistImageHandler;
use nimbus_worker::runner::{JobCtx, JobHandler};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

fn ctx(pool: &PgPool) -> JobCtx {
    JobCtx::new(
        pool.clone(),
        EventBus::new(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
}

async fn artist(pool: &PgPool) -> (i64, Uuid) {
    sqlx::query_as(
        "INSERT INTO artists (mbid, name) VALUES (gen_random_uuid(), 'A') RETURNING id, mbid",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn flag(pool: &PgPool, id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT image FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fetch_artist_image_job_writes_the_flag(pool: PgPool) {
    let (hit, hit_mbid) = artist(&pool).await;
    let (miss, miss_mbid) = artist(&pool).await;
    let ttl = Duration::from_secs(3600);
    mb_cache::put(
        &pool,
        &format!("artist_image:{hit_mbid}"),
        &json!({"url": "https://i/x.jpg"}),
        ttl,
    )
    .await
    .unwrap();
    mb_cache::put(
        &pool,
        &format!("artist_image:{miss_mbid}"),
        &json!({"url": null}),
        ttl,
    )
    .await
    .unwrap();
    let c = ctx(&pool);
    for id in [hit, miss] {
        FetchArtistImageHandler
            .handle(Job::FetchArtistImage { artist_id: id }, &c)
            .await
            .unwrap();
    }
    assert_eq!(flag(&pool, hit).await.as_deref(), Some("yes"));
    assert_eq!(flag(&pool, miss).await.as_deref(), Some("no"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fetch_artist_image_job_for_a_deleted_artist_is_a_noop(pool: PgPool) {
    FetchArtistImageHandler
        .handle(Job::FetchArtistImage { artist_id: 999 }, &ctx(&pool))
        .await
        .unwrap();
}
