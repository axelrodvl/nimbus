// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::Arc;
use std::time::Duration;

use nimbus_core::events::{Event, EventBus};
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_core::model::*;
use nimbus_core::settings::Settings;
use nimbus_db::repo::{acquisition, albums, artists, jobs, tracks};
use nimbus_db::settings::SettingsStore;
use nimbus_worker::acquisition::{RetryMissingHandler, BATCH};
use nimbus_worker::{JobCtx, JobHandler, WorkerConfig, WorkerPool};
use sqlx::PgPool;
use uuid::Uuid;

fn ctx(pool: &PgPool, events: EventBus) -> JobCtx {
    JobCtx::new(
        pool.clone(),
        events,
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
}

async fn artist(pool: &PgPool) -> i64 {
    artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Artist".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id
}

/// Альбом из треков с заданными статусами; `due` — авто-повтор уже наступил.
async fn album(pool: &PgPool, artist_id: i64, statuses: &[TrackStatus], due: bool) -> i64 {
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
    for (i, st) in statuses.iter().enumerate() {
        let t = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: a.id,
                artist_id,
                title: format!("T{i}"),
                disc_no: 1,
                position: i as i32 + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        let reason = (*st == TrackStatus::NotFound).then_some(NotFoundReason::NoMatch);
        tracks::set_status(pool, t.id, *st, reason).await.unwrap();
    }
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    let when = if due {
        "- interval '1 minute'"
    } else {
        "+ interval '1 day'"
    };
    sqlx::query(&format!(
        "INSERT INTO album_search_state (album_id, next_retry_at, auto_retries) VALUES ($1, now() {when}, 1)"
    ))
    .bind(a.id)
    .execute(pool)
    .await
    .unwrap();
    a.id
}

async fn discover_jobs(pool: &PgPool) -> Vec<jobs::JobRow> {
    let mut v: Vec<_> = jobs::list(pool, Some("queued"), 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == "discover_album")
        .collect();
    v.sort_by_key(|j| j.id);
    v
}

use TrackStatus::{Found, NotFound, Ready};

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn takes_only_due_missing_and_partial_albums(pool: PgPool) {
    let ar = artist(&pool).await;
    let missing = album(&pool, ar, &[NotFound, NotFound], true).await;
    let partial = album(&pool, ar, &[Found, NotFound], true).await;
    let not_due = album(&pool, ar, &[NotFound], false).await;
    let found = album(&pool, ar, &[Found, Ready], true).await;
    let events = EventBus::new();
    let mut rx = events.subscribe();

    RetryMissingHandler
        .handle(Job::RetryMissing, &ctx(&pool, events))
        .await
        .unwrap();

    let jobs = discover_jobs(&pool).await;
    let mut got: Vec<i64> = jobs
        .iter()
        .map(|j| j.payload["album_id"].as_i64().unwrap())
        .collect();
    got.sort_unstable();
    assert_eq!(got, vec![missing, partial]);
    assert!(
        jobs.iter().all(|j| j.priority == PRIORITY_BACKGROUND),
        "авто-повтор фоновый"
    );

    // not_found → adding только у выбранных; найденные треки партиала не тронуты.
    let st = |a| {
        let pool = pool.clone();
        async move {
            tracks::list_by_album(&pool, a)
                .await
                .unwrap()
                .into_iter()
                .map(|t| t.status)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(st(missing).await, vec![TrackStatus::Adding; 2]);
    assert_eq!(st(partial).await, vec![Found, TrackStatus::Adding]);
    assert_eq!(st(not_due).await, vec![NotFound]);

    // Счётчик авто-повторов вырос, расписание снято (переустановит завершение поиска).
    for a in [missing, partial] {
        let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
        assert_eq!((s.auto_retries, s.next_retry_at), (2, None));
    }
    let s = acquisition::get_state(&pool, not_due)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.auto_retries, 1);
    assert!(s.next_retry_at.is_some());
    // У найденного просроченная запись сброшена без постановки поиска.
    let s = acquisition::get_state(&pool, found).await.unwrap().unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at), (1, None));

    let mut changed = 0;
    while let Ok(e) = rx.try_recv() {
        if matches!(
            e,
            Event::TrackStatus {
                status: TrackStatus::Adding,
                ..
            }
        ) {
            changed += 1;
        }
    }
    assert_eq!(changed, 3, "UI узнаёт о переводе треков в adding");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn orphan_album_gets_search(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound], true).await;
    sqlx::query("DELETE FROM album_search_state WHERE album_id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    RetryMissingHandler
        .handle(Job::RetryMissing, &ctx(&pool, EventBus::new()))
        .await
        .unwrap();
    let jobs = discover_jobs(&pool).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].payload["album_id"].as_i64(), Some(a));
    let t = tracks::list_by_album(&pool, a).await.unwrap();
    assert_eq!(t[0].status, TrackStatus::Adding);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn one_run_takes_at_most_a_batch_and_the_rest_wait(pool: PgPool) {
    let ar = artist(&pool).await;
    for _ in 0..(BATCH + 3) {
        album(&pool, ar, &[NotFound], true).await;
    }
    let c = ctx(&pool, EventBus::new());
    RetryMissingHandler
        .handle(Job::RetryMissing, &c)
        .await
        .unwrap();
    assert_eq!(discover_jobs(&pool).await.len() as i64, BATCH);
    // Следующий запуск добирает остаток; уже ищущиеся альбомы не берутся повторно.
    RetryMissingHandler
        .handle(Job::RetryMissing, &c)
        .await
        .unwrap();
    assert_eq!(discover_jobs(&pool).await.len() as i64, BATCH + 3);
    RetryMissingHandler
        .handle(Job::RetryMissing, &c)
        .await
        .unwrap();
    assert_eq!(discover_jobs(&pool).await.len() as i64, BATCH + 3);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn rejects_foreign_job_kinds(pool: PgPool) {
    let r = RetryMissingHandler
        .handle(Job::EvictCache, &ctx(&pool, EventBus::new()))
        .await;
    assert!(matches!(r, Err(nimbus_worker::JobError::Fatal(_))));
    assert_eq!(RetryMissingHandler.kinds(), [Job::RETRY_MISSING]);
}

fn fast_cfg() -> WorkerConfig {
    WorkerConfig {
        poll_interval: Duration::from_millis(50),
        maintenance_interval: Duration::from_millis(20),
        // Задача вытеснения ставится заметно позже: к её появлению проверка автоповтора
        // уже прошла несколько раз (на этом держится вывод «не поставили»).
        retry_missing_interval: Some(Duration::from_millis(10)),
        evict_interval: Some(Duration::from_millis(120)),
        shutdown_timeout: Duration::from_secs(2),
        ..WorkerConfig::default()
    }
}

async fn kinds_in_queue(pool: &PgPool) -> Vec<String> {
    jobs::list(pool, Some("queued"), 100)
        .await
        .unwrap()
        .into_iter()
        .map(|j| j.kind)
        .collect()
}

async fn maintenance_with(pool: &PgPool, auto_retry: bool) -> Vec<String> {
    let mut defaults = Settings::default();
    defaults.search.auto_retry = auto_retry;
    let store = SettingsStore::new(pool.clone(), defaults);
    let c = ctx(pool, EventBus::new()).with_settings(store);
    // Обработчиков нет — задачи только копятся в очереди.
    let pool_w = WorkerPool::spawn(c, vec![], fast_cfg());
    // Обслуживание отработало, раз появилась задача вытеснения (она ставится тем же циклом).
    nimbus_testkit::eventually(Duration::from_secs(10), || async {
        kinds_in_queue(pool)
            .await
            .iter()
            .any(|k| k == "evict_cache")
    })
    .await;
    // Дадим циклу сделать ещё несколько проходов.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let kinds = kinds_in_queue(pool).await;
    pool_w.shutdown().await;
    kinds
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn maintenance_enqueues_retry_missing_when_auto_retry_is_on(pool: PgPool) {
    let kinds = maintenance_with(&pool, true).await;
    assert_eq!(
        kinds.iter().filter(|k| *k == "retry_missing").count(),
        1,
        "{kinds:?}"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn maintenance_skips_retry_missing_when_auto_retry_is_off(pool: PgPool) {
    let kinds = maintenance_with(&pool, false).await;
    assert!(!kinds.iter().any(|k| k == "retry_missing"), "{kinds:?}");
}
