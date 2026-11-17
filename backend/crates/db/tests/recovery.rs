// Интеграционные тесты рывка восстановления (ревью B16): unwrap допустим.
#![allow(clippy::unwrap_used)]
use nimbus_core::jobs::Job;
use nimbus_core::model::*;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use nimbus_db::repo::recovery::{kick, KickReport};
use nimbus_db::repo::*;
use sqlx::PgPool;
use uuid::Uuid;

const KINDS: &[&str] = &["import_artist", "discover_artist"];

async fn artist(pool: &PgPool, in_library: bool) -> i64 {
    let a = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Artist".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    if in_library {
        artists::set_in_library(pool, a.id, true).await.unwrap();
    }
    a.id
}

/// Альбом из одного трека; возвращает `(album_id, track_id)`.
async fn album(pool: &PgPool, artist_id: i64, status: TrackStatus) -> (i64, i64) {
    let a = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id,
            title: "Album".into(),
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
            artist_id,
            title: "T".into(),
            disc_no: 1,
            position: 1,
            duration_ms: None,
        },
    )
    .await
    .unwrap();
    let reason = (status == TrackStatus::NotFound).then_some(NotFoundReason::NoMatch);
    tracks::set_status(pool, t.id, status, reason)
        .await
        .unwrap();
    albums::set_in_library(pool, a.id, true).await.unwrap();
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    (a.id, t.id)
}

async fn schedule(pool: &PgPool, album_id: i64, retry: &str, auto_retries: i32) {
    sqlx::query(&format!(
        "INSERT INTO album_search_state (album_id, next_retry_at, auto_retries)
         VALUES ($1, now() + interval '{retry}', $2)
         ON CONFLICT (album_id) DO UPDATE SET next_retry_at = EXCLUDED.next_retry_at,
                                              auto_retries = EXCLUDED.auto_retries"
    ))
    .bind(album_id)
    .bind(auto_retries)
    .execute(pool)
    .await
    .unwrap();
}

async fn pin(pool: &PgPool, track_id: i64, state: &str, retry: Option<&str>) {
    sqlx::query(
        "INSERT INTO pinned_tracks (track_id, state, error, retries, next_retry_at)
         VALUES ($1, $2, 'boom', 4, CASE WHEN $3::text IS NULL THEN NULL ELSE now() + $3::interval END)",
    )
    .bind(track_id)
    .bind(state)
    .bind(retry)
    .execute(pool)
    .await
    .unwrap();
}

async fn failed_job(pool: &PgPool, job: Job, fatal: bool, crashes: i32) -> i64 {
    let id = jobs::enqueue(pool, &job, EnqueueOpts::default())
        .await
        .unwrap()
        .unwrap();
    jobs::claim(pool, "w", KINDS).await.unwrap().unwrap();
    jobs::fail(pool, id, "w", "mb down", None, fatal)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET crashes = $2, revivals = 3, attempts = 5 WHERE id = $1")
        .bind(id)
        .bind(crashes)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn job_state(pool: &PgPool, id: i64) -> (String, i32, i32) {
    sqlx::query_as("SELECT state, attempts, revivals FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn kick_restarts_schedules_pins_and_failed_jobs(pool: PgPool) {
    let ar = artist(&pool, true).await;
    let (a, t1) = album(&pool, ar, TrackStatus::NotFound).await;
    schedule(&pool, a, "20 days", 4).await;
    let (_, t2) = album(&pool, ar, TrackStatus::Found).await;
    pin(&pool, t1, "failed", Some("1 day")).await;
    pin(&pool, t2, "failed", None).await;
    let job = failed_job(&pool, Job::ImportArtist { artist_id: ar }, false, 0).await;
    // Артист без альбомов и без задачи: ему ставится импорт.
    let bare = artist(&pool, true).await;
    sqlx::query("UPDATE artists SET added_at = now() WHERE id = $1")
        .bind(bare)
        .execute(&pool)
        .await
        .unwrap();

    let report = kick(&pool, 3).await.unwrap();
    assert_eq!(
        report,
        KickReport {
            albums: 1,
            pins: 2,
            jobs: 1,
            imports: 1
        }
    );
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert!(s.next_retry_at.unwrap() <= chrono::Utc::now());
    assert_eq!(s.auto_retries, 0);
    let pins: Vec<(String, Option<String>, i32, bool)> = sqlx::query_as(
        "SELECT state, error, retries, next_retry_at IS NULL FROM pinned_tracks ORDER BY track_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(pins.len(), 2);
    for p in pins {
        assert_eq!(p, ("queued".into(), None, 0, true));
    }
    assert_eq!(job_state(&pool, job).await, ("queued".into(), 0, 0));
    let queued = jobs::list(&pool, Some("queued"), 10).await.unwrap();
    assert!(queued
        .iter()
        .any(|j| j.dedup_key.as_deref() == Some(&format!("import_artist:{bare}"))));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn kick_skips_fatal_and_crash_looping_jobs(pool: PgPool) {
    let fatal = failed_job(&pool, Job::ImportArtist { artist_id: 1 }, true, 0).await;
    let crashing = failed_job(&pool, Job::DiscoverArtist { artist_id: 2 }, false, 3).await;
    let report = kick(&pool, 3).await.unwrap();
    assert_eq!(report.jobs, 0);
    assert_eq!(job_state(&pool, fatal).await.0, "failed");
    assert_eq!(job_state(&pool, crashing).await.0, "failed");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn kick_leaves_found_albums_and_active_jobs_alone(pool: PgPool) {
    let ar = artist(&pool, true).await;
    let (found, _) = album(&pool, ar, TrackStatus::Found).await;
    let (searching, _) = album(&pool, ar, TrackStatus::Adding).await;
    schedule(&pool, searching, "5 days", 2).await;
    // Упавшая задача, вытесненная активной такой же.
    failed_job(&pool, Job::ImportArtist { artist_id: ar }, false, 0).await;
    let active = jobs::enqueue(
        &pool,
        &Job::ImportArtist { artist_id: ar },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let report = kick(&pool, 3).await.unwrap();
    assert_eq!((report.albums, report.jobs), (0, 0));
    assert!(acquisition::get_state(&pool, found)
        .await
        .unwrap()
        .is_none());
    let s = acquisition::get_state(&pool, searching)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.auto_retries, 2, "ищущийся альбом не трогаем");
    assert_eq!(job_state(&pool, active).await.0, "queued");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn last_version_roundtrip_keeps_downloads_paused(pool: PgPool) {
    use nimbus_db::settings::*;
    assert_eq!(last_version(&pool).await.unwrap(), None);
    set_downloads_paused(&pool, true).await.unwrap();
    set_last_version(&pool, "1.2.3").await.unwrap();
    assert_eq!(last_version(&pool).await.unwrap().as_deref(), Some("1.2.3"));
    assert!(downloads_paused(&pool).await.unwrap());
    set_downloads_paused(&pool, false).await.unwrap();
    assert_eq!(last_version(&pool).await.unwrap().as_deref(), Some("1.2.3"));
}
