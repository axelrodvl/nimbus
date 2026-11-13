// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::events::EventBus;
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs;
use nimbus_worker::{JobCtx, JobError, JobHandler, WorkerConfig, WorkerPool};
use sqlx::PgPool;

fn fast_cfg() -> WorkerConfig {
    WorkerConfig {
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        poll_interval: Duration::from_millis(50),
        maintenance_interval: Duration::from_secs(3600),
        shutdown_timeout: Duration::from_secs(2),
        ..WorkerConfig::default()
    }
}

fn ctx(pool: &PgPool) -> JobCtx {
    JobCtx::new(
        pool.clone(),
        EventBus::new(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        std::sync::Arc::new(nimbus_trackers::ProviderRegistry::new(vec![])),
    )
}

/// Падает `fail_times` раз заданным способом, затем успешен.
struct Flaky {
    calls: AtomicU32,
    fail_times: u32,
    mode: &'static str,
}

#[async_trait]
impl JobHandler for Flaky {
    fn kinds(&self) -> &'static [&'static str] {
        &["discover_album"]
    }
    async fn handle(&self, _job: Job, _ctx: &JobCtx) -> Result<(), JobError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n <= self.fail_times {
            match self.mode {
                "retry" => {
                    return Err(JobError::Retry {
                        after: Duration::from_millis(20),
                        reason: "temp".into(),
                    })
                }
                "panic" => panic!("boom"),
                "fatal" => return Err(JobError::Fatal("nope".into())),
                _ => return Err(anyhow::anyhow!("unexpected").into()),
            }
        }
        Ok(())
    }
}

async fn wait_state(pool: &PgPool, id: i64, want: &str) -> nimbus_db::repo::jobs::JobRow {
    let get = || async {
        jobs::list(pool, None, 50)
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap()
    };
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        get().await.state == want
    })
    .await; // задача должна дойти до нужного состояния
    get().await
}

async fn run_flaky(
    pool: PgPool,
    mode: &'static str,
    fail_times: u32,
) -> (Arc<Flaky>, jobs::JobRow, WorkerPool) {
    let h = Arc::new(Flaky {
        calls: AtomicU32::new(0),
        fail_times,
        mode,
    });
    let pool_w = WorkerPool::spawn(
        ctx(&pool),
        vec![(h.clone() as Arc<dyn JobHandler>, 1)],
        fast_cfg(),
    );
    let id = jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, None)
        .await
        .unwrap()
        .unwrap();
    let row = wait_state(&pool, id, "done").await;
    (h, row, pool_w)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retries_twice_then_done(pool: PgPool) {
    let (h, row, w) = run_flaky(pool, "retry", 2).await;
    assert_eq!(row.attempts, 3);
    assert_eq!(h.calls.load(Ordering::SeqCst), 3);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unexpected_errors_use_backoff(pool: PgPool) {
    let (_, row, w) = run_flaky(pool, "unexpected", 2).await;
    assert_eq!(row.attempts, 3);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn panic_does_not_kill_worker(pool: PgPool) {
    let (h, row, w) = run_flaky(pool, "panic", 1).await;
    assert_eq!(row.attempts, 2);
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn fatal_is_not_retried(pool: PgPool) {
    let h = Arc::new(Flaky {
        calls: AtomicU32::new(0),
        fail_times: 10,
        mode: "fatal",
    });
    let w = WorkerPool::spawn(
        ctx(&pool),
        vec![(h.clone() as Arc<dyn JobHandler>, 1)],
        fast_cfg(),
    );
    let id = jobs::enqueue(&pool, &Job::DiscoverAlbum { album_id: 1 }, None)
        .await
        .unwrap()
        .unwrap();
    let row = wait_state(&pool, id, "failed").await;
    assert_eq!(row.attempts, 1);
    assert_eq!(row.last_error.as_deref(), Some("nope"));
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn handlers_complete_jobs_via_notify(pool: PgPool) {
    // poll_interval большой: задача должна подхватиться по NOTIFY
    let cfg = WorkerConfig {
        poll_interval: Duration::from_secs(60),
        ..fast_cfg()
    };
    let w = WorkerPool::spawn(ctx(&pool), nimbus_worker::handlers::default_handlers(), cfg);
    tokio::time::sleep(Duration::from_millis(300)).await; // дать LISTEN подключиться
                                                          // Реальный обработчик discover требует существующего артиста (без альбомов в библиотеке — no-op).
    let artist_id = nimbus_db::repo::artists::upsert_by_mbid(
        &pool,
        &nimbus_core::model::NewArtist {
            mbid: uuid::Uuid::new_v4(),
            name: "Test".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id;
    let a = jobs::enqueue(&pool, &Job::DiscoverArtist { artist_id }, None)
        .await
        .unwrap()
        .unwrap();
    let b = jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: 1,
            album_id: 1,
        },
        None,
    )
    .await
    .unwrap()
    .unwrap();
    wait_state(&pool, a, "done").await;
    // Торрента 1 нет: настоящий обработчик verify отвечает `Fatal` (без повторов).
    let row = wait_state(&pool, b, "failed").await;
    assert!(row.last_error.unwrap().contains("not found"));
    w.shutdown().await;
}
