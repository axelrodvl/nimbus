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
