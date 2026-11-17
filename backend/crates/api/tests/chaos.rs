// Тесты на отказы шага 35: рестарт посередине, падающие внешние сервисы, пропавшие пиры,
// исчерпание попыток, двойная доставка. unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
#![cfg(feature = "test-fakes")]
mod common;

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use common::rig::{Behavior, Rig, ALBUM, ARTIST, TRACKS};
use common::{post_json, request_json, router};
use nimbus_api::download_manager::{DownloadManager, ManagerConfig};
use nimbus_api::stream::Watcher;
use nimbus_core::jobs::Job;
use nimbus_core::settings::PerformanceSettings;
use nimbus_db::repo::pins;
use nimbus_library::LibraryService;
use nimbus_worker::handlers::handlers;
use sqlx::PgPool;
use tower::ServiceExt;

const LONG: Duration = Duration::from_secs(60);

async fn add_artist(rig: &Rig) {
    let (code, v) = post_json(
        router(rig.state.clone()),
        "/api/library",
        serde_json::json!({"type": "artist", "mbid": ARTIST}),
    )
    .await;
    assert_eq!(code, 202, "{v}");
}

/// Добавление артиста при «зависшем» MB: артист уже в БД (создаём без сети), импорт ставим в очередь.
async fn add_artist_slow(rig: &Rig, pool: &PgPool) {
    sqlx::query(
        "INSERT INTO artists (mbid, name, in_library) VALUES ($1::uuid, 'Radiohead', TRUE)",
    )
    .bind(ARTIST)
    .execute(pool)
    .await
    .unwrap();
    let id = count(pool, "SELECT id FROM artists LIMIT 1").await;
    LibraryService::new(pool.clone(), rig.mb.clone(), rig.events.clone())
        .enqueue_import(id)
        .await
        .unwrap();
}

async fn track_states(pool: &PgPool) -> Vec<(String, Option<String>)> {
    sqlx::query_as("SELECT status, status_reason FROM tracks WHERE in_library ORDER BY position")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn all_tracks(pool: &PgPool, status: &str) -> bool {
    let s = track_states(pool).await;
    s.len() == TRACKS && s.iter().all(|(st, _)| st == status)
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn job_running(pool: &PgPool, kind: &str) -> bool {
    count(
        pool,
        &format!("SELECT count(*) FROM jobs WHERE kind = '{kind}' AND state = 'running'"),
    )
    .await
        > 0
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn restart_in_the_middle_finishes_without_duplicates(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(120),
    )
    .await;
    // MusicBrainz «завис»: импорт ждёт ответа, когда пул «падает».
    rig.slow_mb.store(true, std::sync::atomic::Ordering::SeqCst);
    let first = rig.workers().await;
    add_artist_slow(&rig, &pool).await;
    nimbus_testkit::eventually(LONG, || async { job_running(&pool, "import_artist").await }).await;

    // «Падение»: пул останавливается, пока поиск висит.
    first.shutdown().await;
    assert_eq!(
        count(&pool, "SELECT count(*) FROM jobs WHERE state = 'running'").await,
        0,
        "после остановки ни одна задача не осталась running"
    );

    // Новый пул на той же БД доводит конвейер до конца.
    rig.slow_mb
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let second = rig.workers().await;
    nimbus_testkit::eventually(LONG, || async { all_tracks(&pool, "found").await }).await;

    assert_eq!(count(&pool, "SELECT count(*) FROM album_torrents").await, 1);
    assert_eq!(count(&pool, "SELECT count(*) FROM torrents").await, 1);
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM (SELECT track_id FROM track_sources GROUP BY track_id, torrent_id, file_index HAVING count(*) > 1) d"
        )
        .await,
        0,
        "дублей track_sources нет"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE status = 'adding'").await,
        0
    );
    second.shutdown().await;
    rig.finish().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_provider_that_is_down_or_hangs_does_not_stop_the_search(pool: PgPool) {
    for behavior in [Behavior::Down, Behavior::Hangs] {
        sqlx::query("TRUNCATE artists CASCADE")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("TRUNCATE jobs, torrents CASCADE")
            .execute(&pool)
            .await
            .unwrap();
        let rig = Rig::start(
            pool.clone(),
            2,
            Duration::from_secs(30),
            Duration::from_millis(400),
        )
        .await;
        rig.providers[0].set(behavior);
        let workers = rig.workers().await;
        let started = Instant::now();
        add_artist(&rig).await;
        nimbus_testkit::eventually(LONG, || async { all_tracks(&pool, "found").await }).await;
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "альбом найден через второй провайдер без долгих ожиданий"
        );
        let health = rig.registry.health();
        let bad = health
            .iter()
            .find(|h| h.source == rig.providers[0].source)
            .unwrap();
        assert!(
            bad.open || bad.last_error.is_some(),
            "сбой провайдера зафиксирован"
        );
        // Рабочий провайдер отвечал, неисправному не слали запросы бесконечно.
        assert!(rig.providers[1].calls() >= 1);
        // До размыкания предохранителя: порог неудачных запросов × (попытка + повторы внутри запроса).
        let budget = (nimbus_trackers::registry::BREAKER_THRESHOLD
            * (nimbus_trackers::registry::REQUEST_RETRIES + 1)) as usize
            + 3;
        assert!(
            rig.providers[0].calls() <= budget,
            "{} > {budget}",
            rig.providers[0].calls()
        );
        workers.shutdown().await;
        rig.finish().await;
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn musicbrainz_answering_503_every_other_request_still_imports(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
    .await;
    rig.flaky_mb
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let workers = rig.workers().await;
    let lib = LibraryService::new(pool.clone(), rig.mb.clone(), rig.events.clone());
    // Добавление артиста тоже ходит в MB: повторяем, как делает пользователь, пока не вышло.
    nimbus_testkit::eventually(LONG, || async {
        lib.add_artist(ARTIST.parse().unwrap()).await.is_ok()
    })
    .await;
    nimbus_testkit::eventually(LONG, || async { all_tracks(&pool, "found").await }).await;
    assert_eq!(
        count(&pool, "SELECT count(*) FROM albums WHERE in_library").await,
        1
    );
    workers.shutdown().await;
    rig.finish().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn all_peers_vanishing_stalls_the_pin_and_the_stream_times_out(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
    .await;
    let workers = rig.workers().await;
    add_artist(&rig).await;
    nimbus_testkit::eventually(LONG, || async { all_tracks(&pool, "found").await }).await;
    workers.shutdown().await;
    let album_id = count(&pool, "SELECT id FROM albums LIMIT 1").await;

    // Раздача пропала до начала загрузки.
    rig.swarm.stop().await;
    let app = router(rig.state.clone());
    let (code, _) = request_json(
        app.clone(),
        "POST",
        &format!("/api/albums/{album_id}/download"),
        None,
    )
    .await;
    assert_eq!(code, 200);
    let mut manager = DownloadManager::new(
        rig.state.clone(),
        ManagerConfig {
            tick: Duration::from_millis(50),
            stall_timeout: Duration::from_millis(500),
            stall_timeout_no_peers: Duration::from_millis(500),
            ..ManagerConfig::default()
        },
    );
    let mut watcher = Watcher::new();
    let started = Instant::now();
    let track_id = count(&pool, "SELECT id FROM tracks ORDER BY position LIMIT 1").await;
    loop {
        watcher.tick(&rig.state).await.unwrap();
        manager.tick().await.unwrap();
        let pin = pins::get(&pool, track_id).await.unwrap().unwrap();
        if pin.state == nimbus_core::model::PinState::Failed {
            assert_eq!(pin.error.as_deref(), Some("stalled"));
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "закрепление не перешло в failed: {:?}",
            pin.state
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Стрим без пиров не висит: ошибка по таймауту первого байта.
    let mut st = rig.state.clone();
    st.first_byte_timeout = Duration::from_millis(500);
    let t0 = Instant::now();
    let res = router(st)
        .oneshot(
            Request::get(format!("/api/tracks/{track_id}/stream"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(res.status().is_server_error(), "{}", res.status());
    assert!(t0.elapsed() < Duration::from_secs(15));
    rig.finish().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_discover_marks_tracks_not_found_and_album_leaves_adding(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
    .await;
    rig.providers[0].set(Behavior::Down);
    // Импорт без поиска: discover-задачи остаются в очереди.
    let importer = rig.workers_only(&[Job::IMPORT_ARTIST]).await;
    add_artist(&rig).await;
    nimbus_testkit::eventually(LONG, || async {
        count(
            &pool,
            "SELECT count(*) FROM jobs WHERE kind = 'discover_album' AND state = 'queued'",
        )
        .await
            == 1
    })
    .await;
    importer.shutdown().await;
    // Одна попытка: первая же неудача — исчерпание.
    sqlx::query(
        "UPDATE jobs SET max_attempts = 1 WHERE kind IN ('discover_album', 'discover_artist')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let workers = rig.workers().await;
    // Шесть запросов двух задач к упавшему провайдеру размыкают предохранитель (порог 5). Если вторая
    // задача стартует уже после этого, все её ошибки — «предохранитель разомкнут», и она законно
    // откладывается до его закрытия (60 с + запас) без траты попытки. Поэтому дедлайн больше минуты.
    nimbus_testkit::eventually(Duration::from_secs(180), || async {
        all_tracks(&pool, "not_found").await
    })
    .await;
    let reasons = track_states(&pool).await;
    // Причина указана: при ошибках провайдеров на последней попытке discover сам ставит `no_torrents`,
    // а хук исчерпания — `search_failed` (см. «Замечено» в Журнале).
    assert!(
        reasons
            .iter()
            .all(|(_, r)| matches!(r.as_deref(), Some("no_torrents" | "search_failed"))),
        "{reasons:?}"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE status = 'adding'").await,
        0
    );
    workers.shutdown().await;
    rig.finish().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_verify_marks_tracks_not_found_with_a_reason(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_millis(400),
        Duration::from_secs(10),
    )
    .await;
    // Поиск находит раздачу, но раздающих нет: метаданные получить нельзя.
    rig.swarm.stop().await;
    let early = rig
        .workers_only(&[
            Job::IMPORT_ARTIST,
            Job::DISCOVER_ALBUM,
            Job::DISCOVER_ARTIST,
        ])
        .await;
    add_artist(&rig).await;
    nimbus_testkit::eventually(LONG, || async {
        count(
            &pool,
            "SELECT count(*) FROM jobs WHERE kind = 'verify_torrent' AND state = 'queued'",
        )
        .await
            >= 1
    })
    .await;
    early.shutdown().await;
    sqlx::query("UPDATE jobs SET max_attempts = 1 WHERE kind = 'verify_torrent'")
        .execute(&pool)
        .await
        .unwrap();
    let workers = rig.workers().await;
    nimbus_testkit::eventually(LONG, || async { all_tracks(&pool, "not_found").await }).await;
    let reasons = track_states(&pool).await;
    assert!(
        reasons.iter().all(|(_, r)| r.is_some()),
        "причина указана: {reasons:?}"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM tracks WHERE status = 'adding'").await,
        0
    );
    workers.shutdown().await;
    rig.finish().await;
}

/// Снимок содержимого таблиц без времён: для сравнения состояний.
async fn db_snapshot(pool: &PgPool) -> String {
    let parts = [
        "SELECT coalesce(string_agg((to_jsonb(t) - ARRAY['created_at','updated_at','sync_txid'])::text, E'\\n' ORDER BY id), '') FROM tracks t",
        "SELECT coalesce(string_agg((to_jsonb(t) - ARRAY['created_at','updated_at','sync_txid'])::text, E'\\n' ORDER BY id), '') FROM albums t",
        "SELECT coalesce(string_agg((to_jsonb(t) - ARRAY['created_at','updated_at','last_checked_at','meta_fetched_at'])::text, E'\\n' ORDER BY id), '') FROM torrents t",
        "SELECT count(*)::text FROM torrent_files",
        "SELECT coalesce(string_agg((to_jsonb(t) - ARRAY['created_at','updated_at','verified_at','sync_txid'])::text, E'\\n' ORDER BY album_id, torrent_id), '') FROM album_torrents t",
        "SELECT coalesce(string_agg((to_jsonb(t) - ARRAY['id','created_at','updated_at'])::text, E'\\n' ORDER BY track_id, torrent_id, file_index), '') FROM track_sources t",
        "SELECT coalesce(string_agg(kind || ':' || state || ':' || count(*), ','), '') FROM (SELECT kind, state, count(*) FROM jobs GROUP BY 1,2 ORDER BY 1,2) j",
    ];
    let mut out = String::new();
    for sql in parts {
        let sql = if sql.contains("FROM (SELECT kind") {
            "SELECT coalesce(string_agg(kind || ':' || state || ':' || n, ',' ORDER BY kind, state), '') FROM (SELECT kind, state, count(*) AS n FROM jobs GROUP BY 1,2) j"
        } else {
            sql
        };
        let s: String = sqlx::query_scalar(sql).fetch_one(pool).await.unwrap();
        out.push_str(&s);
        out.push('\n');
    }
    out
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn running_any_job_twice_gives_the_same_state_as_running_it_once(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
    .await;
    let ctx = rig.job_ctx();
    let hs = handlers(&PerformanceSettings::default());
    let handler_for = |kind: &str| {
        hs.iter()
            .find(|(h, _)| h.kinds().contains(&kind))
            .map(|(h, _)| h.clone())
            .unwrap()
    };
    let lib = LibraryService::new(pool.clone(), rig.mb.clone(), rig.events.clone());
    lib.add_artist(ARTIST.parse().unwrap()).await.unwrap();
    let artist_id = count(&pool, "SELECT id FROM artists LIMIT 1").await;

    let mut ran = vec![];
    let step = |job: Job| {
        let h = handler_for(match &job {
            Job::DiscoverAlbum { .. } => Job::DISCOVER_ALBUM,
            Job::DiscoverArtist { .. } => Job::DISCOVER_ARTIST,
            Job::ImportArtist { .. } => Job::IMPORT_ARTIST,
            Job::VerifyTorrent { .. } => Job::VERIFY_TORRENT,
            Job::ProcessCue { .. } => Job::PROCESS_CUE,
            Job::EvictCache => Job::EVICT_CACHE,
            Job::RetryMissing => Job::RETRY_MISSING,
        });
        (job, h)
    };

    // Порядок как в конвейере; параметры берутся из состояния БД после предыдущего шага.
    let mut jobs: Vec<Job> = vec![Job::ImportArtist { artist_id }];
    let mut i = 0;
    while i < jobs.len() {
        let (job, h) = step(jobs[i].clone());
        h.handle(job.clone(), &ctx).await.unwrap();
        let once = db_snapshot(&pool).await;
        h.handle(job.clone(), &ctx).await.unwrap();
        let twice = db_snapshot(&pool).await;
        assert_eq!(once, twice, "повторный запуск {job:?} изменил состояние");
        ran.push(job.clone());
        match job {
            Job::ImportArtist { .. } => {
                let album_id = count(&pool, "SELECT id FROM albums LIMIT 1").await;
                jobs.push(Job::DiscoverAlbum { album_id });
                jobs.push(Job::DiscoverArtist { artist_id });
            }
            Job::DiscoverAlbum { album_id } => {
                let torrent_id =
                    count(&pool, "SELECT torrent_id FROM album_torrents LIMIT 1").await;
                jobs.push(Job::VerifyTorrent {
                    torrent_id,
                    album_id,
                });
            }
            Job::VerifyTorrent { .. } => {
                jobs.push(Job::EvictCache);
                jobs.push(Job::RetryMissing);
            }
            _ => {}
        }
        i += 1;
    }
    assert!(ran.len() >= 6, "{ran:?}");
    assert!(
        all_tracks(&pool, "found").await,
        "{:?}",
        track_states(&pool).await
    );
    let _ = ALBUM;
    rig.finish().await;
}
