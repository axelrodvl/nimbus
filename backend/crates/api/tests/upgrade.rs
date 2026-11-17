// Рывок восстановления при смене версии (ревью B16): unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
use nimbus_api::startup::recover_on_upgrade;
use nimbus_core::model::*;
use nimbus_db::repo::{albums, artists, tracks};
use sqlx::PgPool;
use uuid::Uuid;

async fn missing_album(pool: &PgPool) -> i64 {
    let ar = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "A".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    artists::set_in_library(pool, ar.id, true).await.unwrap();
    let a = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: ar.id,
            title: "T".into(),
            primary_type: None,
            secondary_types: vec![],
            year: None,
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let t = tracks::upsert_by_mbid_track(
        pool,
        &NewTrack {
            mbid_recording: Uuid::new_v4(),
            mbid_track: None,
            album_id: a.id,
            artist_id: ar.id,
            title: "x".into(),
            disc_no: 1,
            position: 1,
            duration_ms: None,
        },
    )
    .await
    .unwrap();
    tracks::set_status(
        pool,
        t.id,
        TrackStatus::NotFound,
        Some(NotFoundReason::NoMatch),
    )
    .await
    .unwrap();
    albums::set_in_library(pool, a.id, true).await.unwrap();
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    a.id
}

async fn postpone(pool: &PgPool, album: i64) {
    sqlx::query(
        "INSERT INTO album_search_state (album_id, next_retry_at, auto_retries)
         VALUES ($1, now() + interval '20 days', 4)
         ON CONFLICT (album_id) DO UPDATE SET next_retry_at = EXCLUDED.next_retry_at, auto_retries = 4",
    )
    .bind(album)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn new_version_kicks_everything_once(pool: PgPool) {
    let album = missing_album(&pool).await;
    postpone(&pool, album).await;

    let r = recover_on_upgrade(&pool, "1.0.0", 3).await.unwrap();
    assert_eq!(r.unwrap().albums, 1, "отметки нет, библиотека не пуста");

    postpone(&pool, album).await;
    assert!(recover_on_upgrade(&pool, "1.0.0", 3)
        .await
        .unwrap()
        .is_none());
    let s = nimbus_db::repo::acquisition::get_state(&pool, album)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.auto_retries, 4, "та же версия — расписание не тронуто");

    let r = recover_on_upgrade(&pool, "1.0.1", 3).await.unwrap();
    assert_eq!(r.unwrap().albums, 1);
    let s = nimbus_db::repo::acquisition::get_state(&pool, album)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.auto_retries, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn empty_library_only_records_the_version(pool: PgPool) {
    assert!(recover_on_upgrade(&pool, "1.0.0", 3)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        nimbus_db::settings::last_version(&pool)
            .await
            .unwrap()
            .as_deref(),
        Some("1.0.0")
    );
}
