// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::time::Duration;

use nimbus_core::jobs::Job;
use nimbus_core::model::NewArtist;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use nimbus_db::repo::{albums, artists};
use sqlx::PgPool;
use uuid::Uuid;

async fn library_artist(pool: &PgPool, name: &str, added_minutes_ago: i64) -> i64 {
    let a = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: name.into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    artists::set_in_library(pool, a.id, true).await.unwrap();
    sqlx::query(
        "UPDATE artists SET added_at = now() - make_interval(mins => $2::int) WHERE id = $1",
    )
    .bind(a.id)
    .bind(added_minutes_ago as i32)
    .execute(pool)
    .await
    .unwrap();
    a.id
}

const GRACE: Duration = Duration::from_secs(15 * 60);

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_import_finds_only_old_library_artists_with_no_albums_and_no_job(pool: PgPool) {
    let lost = library_artist(&pool, "Lost", 60).await;
    let fresh = library_artist(&pool, "Fresh", 1).await;
    // не в библиотеке
    let hidden = artists::upsert_by_mbid(
        &pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Hidden".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    // с задачей импорта в любом из «живых» состояний
    let queued = library_artist(&pool, "Queued", 60).await;
    jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: queued },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let done = library_artist(&pool, "Done", 60).await;
    let failed = library_artist(&pool, "Failed", 60).await;
    for id in [done, failed] {
        jobs::enqueue(
            &pool,
            &Job::ImportArtist { artist_id: id },
            EnqueueOpts::default(),
        )
        .await
        .unwrap();
    }
    for (id, state) in [(done, "done"), (failed, "failed")] {
        sqlx::query("UPDATE jobs SET state = $2 WHERE dedup_key = $1")
            .bind(format!("import_artist:{id}"))
            .bind(state)
            .execute(&pool)
            .await
            .unwrap();
    }
    // с альбомом (добавлен одним треком)
    let with_album = library_artist(&pool, "WithAlbum", 60).await;
    albums::upsert_by_rg_mbid(
        &pool,
        &nimbus_core::model::NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: with_album,
            title: "A".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();

    let ids = artists::without_import(&pool, GRACE).await.unwrap();
    assert_eq!(ids, vec![lost]);
    assert!(!ids.contains(&fresh) && !ids.contains(&hidden.id));
}

async fn image_of(pool: &PgPool, id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT image FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn mbid_of(pool: &PgPool, id: i64) -> Uuid {
    sqlx::query_scalar("SELECT mbid FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn set_image_writes_flag_and_skips_unchanged_rows(pool: PgPool) {
    let id = library_artist(&pool, "A", 1).await;
    let mbid = mbid_of(&pool, id).await;
    assert!(artists::set_image(&pool, mbid, Some(true)).await.unwrap());
    assert_eq!(image_of(&pool, id).await.as_deref(), Some("yes"));
    // То же значение: строка не пишется — клиенты не получают пустую дельту.
    let before: i64 = sqlx::query_scalar("SELECT sync_txid FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!artists::set_image(&pool, mbid, Some(true)).await.unwrap());
    let after: i64 = sqlx::query_scalar("SELECT sync_txid FROM artists WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    assert!(artists::set_image(&pool, mbid, Some(false)).await.unwrap());
    assert_eq!(image_of(&pool, id).await.as_deref(), Some("no"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn reset_expired_no_image_only_touches_expired_misses(pool: PgPool) {
    let expired = library_artist(&pool, "Expired", 1).await;
    let fresh = library_artist(&pool, "Fresh", 1).await;
    let yes = library_artist(&pool, "Yes", 1).await;
    for (id, flag, ttl) in [
        (expired, false, -60),
        (fresh, false, 3600),
        (yes, true, -60),
    ] {
        let mbid = mbid_of(&pool, id).await;
        artists::set_image(&pool, mbid, Some(flag)).await.unwrap();
        sqlx::query(
            "INSERT INTO mb_cache (key, response, expires_at)
             VALUES ($1, '{}', now() + make_interval(secs => $2))",
        )
        .bind(format!("artist_image:{mbid}"))
        .bind(f64::from(ttl))
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(artists::reset_expired_no_image(&pool).await.unwrap(), 1);
    assert_eq!(image_of(&pool, expired).await, None);
    assert_eq!(image_of(&pool, fresh).await.as_deref(), Some("no"));
    assert_eq!(image_of(&pool, yes).await.as_deref(), Some("yes"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_image_job_skips_known_flags_active_and_recent_jobs(pool: PgPool) {
    let lost = library_artist(&pool, "Lost", 1).await;
    let known = library_artist(&pool, "Known", 1).await;
    artists::set_image(&pool, mbid_of(&pool, known).await, Some(false))
        .await
        .unwrap();
    let queued = library_artist(&pool, "Queued", 1).await;
    jobs::enqueue(
        &pool,
        &Job::FetchArtistImage { artist_id: queued },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let failed_recently = library_artist(&pool, "Failed", 1).await;
    let job = jobs::enqueue(
        &pool,
        &Job::FetchArtistImage {
            artist_id: failed_recently,
        },
        EnqueueOpts::default(),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE jobs SET state = 'failed' WHERE dedup_key = 'fetch_artist_image:' || $1")
        .bind(failed_recently)
        .execute(&pool)
        .await
        .unwrap();
    let _ = job;
    // Не в библиотеке.
    sqlx::query("INSERT INTO artists (mbid, name) VALUES (gen_random_uuid(), 'Out')")
        .execute(&pool)
        .await
        .unwrap();

    let hour = Duration::from_secs(3600);
    assert_eq!(
        artists::without_image_job(&pool, hour, 10).await.unwrap(),
        vec![lost]
    );
    // Пауза после упавшей задачи прошла — артист снова кандидат.
    let both = artists::without_image_job(&pool, Duration::ZERO, 10)
        .await
        .unwrap();
    assert_eq!(both, vec![lost, failed_recently]);
    assert_eq!(
        artists::without_image_job(&pool, Duration::ZERO, 1)
            .await
            .unwrap()
            .len(),
        1
    );
}
