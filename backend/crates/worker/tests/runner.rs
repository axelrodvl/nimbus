// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::events::EventBus;
use nimbus_core::jobs::Job;
use nimbus_db::repo::jobs::{self, EnqueueOpts};
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
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
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
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts::default(),
    )
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
    let w = WorkerPool::spawn(
        ctx(&pool),
        nimbus_worker::handlers::handlers(&nimbus_core::settings::PerformanceSettings::default()),
        cfg,
    );
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
    let a = jobs::enqueue(
        &pool,
        &Job::DiscoverArtist { artist_id },
        EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    let b = jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: 1,
            album_id: 1,
        },
        EnqueueOpts::default(),
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

/// Обработчик с настраиваемым поведением и счётчиками вызовов `handle` / `on_exhausted`.
#[derive(Clone, Copy)]
enum Behavior {
    Ok,
    Unexpected,
    Fatal,
    /// Ждёт отмену и честно возвращает `Cancelled`.
    CancelAware,
    /// Игнорирует отмену: висит, пока его не прервут.
    Hang,
    /// Работает заданное время, затем успех.
    Sleep(Duration),
}

struct Probe {
    behavior: Behavior,
    calls: AtomicU32,
    exhausted: AtomicU32,
    retried: AtomicU32,
    /// Сколько ближайших вызовов `on_exhausted` должны упасть с ошибкой.
    hook_failures: AtomicU32,
}

impl Probe {
    fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            calls: AtomicU32::new(0),
            exhausted: AtomicU32::new(0),
            retried: AtomicU32::new(0),
            hook_failures: AtomicU32::new(0),
        })
    }
    fn retried(&self) -> u32 {
        self.retried.load(Ordering::SeqCst)
    }
    fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
    fn exhausted(&self) -> u32 {
        self.exhausted.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl JobHandler for Probe {
    fn kinds(&self) -> &'static [&'static str] {
        &["discover_album"]
    }
    async fn handle(&self, _job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.behavior {
            Behavior::Ok => Ok(()),
            Behavior::Unexpected => Err(JobError::Unexpected("nope".into())),
            Behavior::Fatal => Err(JobError::Fatal("fatal".into())),
            Behavior::CancelAware => {
                ctx.cancel.cancelled().await;
                Err(JobError::Cancelled)
            }
            Behavior::Hang => std::future::pending().await,
            Behavior::Sleep(d) => {
                tokio::time::sleep(d).await;
                Ok(())
            }
        }
    }
    async fn on_retry(&self, _job: &Job, _ctx: &JobCtx, _reason: &str) {
        self.retried.fetch_add(1, Ordering::SeqCst);
    }
    async fn on_exhausted(&self, _job: &Job, _ctx: &JobCtx, _reason: &str) -> Result<(), JobError> {
        if self
            .hook_failures
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(JobError::Unexpected("hook db error".into()));
        }
        self.exhausted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn spawn_probe(pool: &PgPool, probe: &Arc<Probe>, cfg: WorkerConfig) -> WorkerPool {
    WorkerPool::spawn(
        ctx(pool),
        vec![(probe.clone() as Arc<dyn JobHandler>, 1)],
        cfg,
    )
}

async fn enqueue_album(pool: &PgPool, max_attempts: Option<i32>) -> i64 {
    jobs::enqueue(
        pool,
        &Job::DiscoverAlbum { album_id: 1 },
        EnqueueOpts {
            max_attempts,
            ..EnqueueOpts::default()
        },
    )
    .await
    .unwrap()
    .unwrap()
}

async fn get_row(pool: &PgPool, id: i64) -> jobs::JobRow {
    jobs::list(pool, None, 50)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn heartbeat_keeps_a_long_job_from_being_run_twice(pool: PgPool) {
    // Обработчик работает втрое дольше stale_after, а обслуживание проверяет «зависшие» каждые 30 мс.
    let probe = Probe::new(Behavior::Sleep(Duration::from_millis(900)));
    let cfg = WorkerConfig {
        stale_after: Duration::from_millis(300),
        heartbeat_interval: Duration::from_millis(50),
        maintenance_interval: Duration::from_millis(30),
        ..fast_cfg()
    };
    let w = spawn_probe(&pool, &probe, cfg);
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "done").await;
    assert_eq!(probe.calls(), 1, "задача не должна запускаться повторно");
    assert_eq!(get_row(&pool, id).await.attempts, 1);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_heartbeat_a_lost_job_is_requeued(pool: PgPool) {
    // Воркер «умер»: строка running с протухшим heartbeat — обслуживание возвращает её в очередь.
    let id = enqueue_album(&pool, None).await;
    jobs::claim(&pool, "dead", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET heartbeat_at = now() - interval '1 hour'")
        .execute(&pool)
        .await
        .unwrap();
    let probe = Probe::new(Behavior::Ok);
    let cfg = WorkerConfig {
        stale_after: Duration::from_millis(300),
        maintenance_interval: Duration::from_millis(30),
        ..fast_cfg()
    };
    let w = spawn_probe(&pool, &probe, cfg);
    let row = wait_state(&pool, id, "done").await;
    assert_eq!(row.attempts, 2, "аварийный путь попытку не возвращает");
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn maintenance_purges_old_sync_tombstones_and_keeps_fresh_ones(pool: PgPool) {
    sqlx::query("INSERT INTO sync_tombstones (entity, entity_id, sync_txid, deleted_at) VALUES ('track', 1, 5, now() - interval '40 days'), ('track', 2, 6, now())")
        .execute(&pool)
        .await
        .unwrap();
    let probe = Probe::new(Behavior::Ok);
    let w = spawn_probe(&pool, &probe, fast_cfg());
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sync_tombstones")
            .fetch_one(&pool)
            .await
            .unwrap()
            == 1
    })
    .await;
    let left: i64 = sqlx::query_scalar("SELECT entity_id FROM sync_tombstones")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 2);
    let floor: i64 =
        sqlx::query_scalar("SELECT (value->>'floor')::bigint FROM settings WHERE key = 'sync'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(floor, 6);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn shutdown_cancels_handler_and_requeues_without_spending_attempt(pool: PgPool) {
    let probe = Probe::new(Behavior::CancelAware);
    let w = spawn_probe(&pool, &probe, fast_cfg());
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "running").await;
    w.shutdown().await;
    let row = get_row(&pool, id).await;
    assert_eq!((row.state.as_str(), row.attempts), ("queued", 0));
    assert!(row.locked_by.is_none());
    assert_eq!(probe.exhausted(), 0, "отмена — не исчерпание");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn shutdown_aborts_handler_that_ignores_cancellation(pool: PgPool) {
    let probe = Probe::new(Behavior::Hang);
    let cfg = WorkerConfig {
        shutdown_timeout: Duration::from_millis(200),
        ..fast_cfg()
    };
    let w = spawn_probe(&pool, &probe, cfg);
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "running").await;
    let started = std::time::Instant::now();
    w.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(5));
    let row = get_row(&pool, id).await;
    assert_eq!((row.state.as_str(), row.attempts), ("queued", 0));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn on_exhausted_is_called_once_when_attempts_run_out(pool: PgPool) {
    let probe = Probe::new(Behavior::Unexpected);
    let w = spawn_probe(&pool, &probe, fast_cfg());
    let id = enqueue_album(&pool, Some(2)).await;
    wait_state(&pool, id, "failed").await;
    nimbus_testkit::eventually(Duration::from_secs(5), || async { probe.exhausted() >= 1 }).await;
    tokio::time::sleep(Duration::from_millis(300)).await; // убедиться, что повторов хука нет
    assert_eq!((probe.calls(), probe.exhausted()), (2, 1));
    assert_eq!(
        probe.retried(),
        1,
        "on_retry — только для запланированного повтора"
    );
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn on_exhausted_is_retried_after_transient_hook_errors(pool: PgPool) {
    let probe = Probe::new(Behavior::Fatal);
    probe.hook_failures.store(2, Ordering::SeqCst);
    let w = spawn_probe(&pool, &probe, fast_cfg());
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "failed").await;
    nimbus_testkit::eventually(Duration::from_secs(10), || async { probe.exhausted() == 1 }).await;
    assert_eq!(probe.calls(), 1, "повторяется хук, а не задача");
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn on_exhausted_is_called_for_fatal_errors(pool: PgPool) {
    let probe = Probe::new(Behavior::Fatal);
    let w = spawn_probe(&pool, &probe, fast_cfg());
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "failed").await;
    nimbus_testkit::eventually(Duration::from_secs(5), || async { probe.exhausted() == 1 }).await;
    assert_eq!(probe.calls(), 1);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn on_exhausted_is_not_called_after_a_successful_retry(pool: PgPool) {
    let h = Arc::new(FlakyWithHook {
        inner: Flaky {
            calls: AtomicU32::new(0),
            fail_times: 1,
            mode: "retry",
        },
        exhausted: AtomicU32::new(0),
    });
    let w = WorkerPool::spawn(
        ctx(&pool),
        vec![(h.clone() as Arc<dyn JobHandler>, 1)],
        fast_cfg(),
    );
    let id = enqueue_album(&pool, None).await;
    wait_state(&pool, id, "done").await;
    assert_eq!(h.exhausted.load(Ordering::SeqCst), 0);
    w.shutdown().await;
}

struct FlakyWithHook {
    inner: Flaky,
    exhausted: AtomicU32,
}

#[async_trait]
impl JobHandler for FlakyWithHook {
    fn kinds(&self) -> &'static [&'static str] {
        self.inner.kinds()
    }
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        self.inner.handle(job, ctx).await
    }
    async fn on_exhausted(&self, _: &Job, _: &JobCtx, _: &str) -> Result<(), JobError> {
        self.exhausted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn on_exhausted_is_called_for_stale_job_out_of_attempts(pool: PgPool) {
    let id = enqueue_album(&pool, Some(1)).await;
    jobs::claim(&pool, "dead", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE jobs SET heartbeat_at = now() - interval '1 hour'")
        .execute(&pool)
        .await
        .unwrap();
    let probe = Probe::new(Behavior::Ok);
    let cfg = WorkerConfig {
        stale_after: Duration::from_millis(300),
        maintenance_interval: Duration::from_millis(30),
        ..fast_cfg()
    };
    let w = spawn_probe(&pool, &probe, cfg);
    wait_state(&pool, id, "failed").await;
    nimbus_testkit::eventually(Duration::from_secs(5), || async { probe.exhausted() == 1 }).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!((probe.calls(), probe.exhausted()), (0, 1));
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn start_recovers_orphans_and_returns_their_attempt(pool: PgPool) {
    let id = enqueue_album(&pool, Some(1)).await;
    jobs::claim(&pool, "crashed-process", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    // max_attempts = 1: без возврата попытки задача бы не запустилась.
    let probe = Probe::new(Behavior::Ok);
    let w = WorkerPool::start(
        ctx(&pool),
        vec![(probe.clone() as Arc<dyn JobHandler>, 1)],
        fast_cfg(),
    )
    .await
    .unwrap();
    let row = wait_state(&pool, id, "done").await;
    assert_eq!(row.attempts, 1);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn higher_priority_jobs_run_first(pool: PgPool) {
    // Один воркер: порядок выполнения = порядок claim.
    struct Order(std::sync::Mutex<Vec<i64>>);
    #[async_trait]
    impl JobHandler for Order {
        fn kinds(&self) -> &'static [&'static str] {
            &["discover_album"]
        }
        async fn handle(&self, job: Job, _: &JobCtx) -> Result<(), JobError> {
            if let Job::DiscoverAlbum { album_id } = job {
                self.0.lock().unwrap().push(album_id);
            }
            Ok(())
        }
    }
    let order = Arc::new(Order(Default::default()));
    for (album, prio) in [(1, -10), (2, 0), (3, 10)] {
        jobs::enqueue(
            &pool,
            &Job::DiscoverAlbum { album_id: album },
            EnqueueOpts::priority(prio),
        )
        .await
        .unwrap()
        .unwrap();
    }
    let w = WorkerPool::spawn(
        ctx(&pool),
        vec![(order.clone() as Arc<dyn JobHandler>, 1)],
        fast_cfg(),
    );
    nimbus_testkit::eventually(Duration::from_secs(5), || async {
        order.0.lock().unwrap().len() == 3
    })
    .await;
    assert_eq!(*order.0.lock().unwrap(), [3, 2, 1]);
    w.shutdown().await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_import_publishes_artist_changed(pool: PgPool) {
    let c = ctx(&pool);
    let mut rx = c.events.subscribe();
    nimbus_worker::handlers::ImportArtistHandler
        .on_exhausted(&Job::ImportArtist { artist_id: 7 }, &c, "mb down")
        .await
        .unwrap();
    assert_eq!(
        rx.try_recv().unwrap(),
        nimbus_core::events::Event::LibraryChanged {
            entity: nimbus_core::events::Entity::Artist,
            id: 7
        }
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn import_retry_publishes_artist_changed_after_state_is_saved(pool: PgPool) {
    let c = ctx(&pool);
    let mut rx = c.events.subscribe();
    nimbus_worker::handlers::ImportArtistHandler
        .on_retry(&Job::ImportArtist { artist_id: 9 }, &c, "503")
        .await;
    assert_eq!(
        rx.try_recv().unwrap(),
        nimbus_core::events::Event::LibraryChanged {
            entity: nimbus_core::events::Entity::Artist,
            id: 9
        }
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn handlers_use_worker_counts_from_settings(pool: PgPool) {
    let _ = pool;
    let perf = nimbus_core::settings::PerformanceSettings {
        discover_workers: 3,
        verify_workers: 5,
        import_workers: 7,
        ..Default::default()
    };
    let counts: Vec<(Vec<&str>, usize)> = nimbus_worker::handlers::handlers(&perf)
        .iter()
        .map(|(h, n)| (h.kinds().to_vec(), *n))
        .collect();
    let of = |kind: &str| counts.iter().find(|(k, _)| k.contains(&kind)).unwrap().1;
    assert_eq!(of("discover_album"), 3);
    assert_eq!(of("discover_artist"), 3);
    assert_eq!(of("verify_torrent"), 5);
    assert_eq!(of("import_artist"), 7);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unparsable_payload_fails_the_job_without_running_the_handler(pool: PgPool) {
    let probe = Probe::new(Behavior::Ok);
    let id = enqueue_album(&pool, None).await;
    sqlx::query(
        "UPDATE jobs SET payload = '{\"album_id\": \"not a number\"}'::jsonb WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    let w = spawn_probe(&pool, &probe, fast_cfg());
    let row = wait_state(&pool, id, "failed").await;
    assert!(row.last_error.unwrap().starts_with("bad payload"));
    assert_eq!(probe.calls(), 0);
    w.shutdown().await;
}

#[test]
fn database_errors_become_unexpected_job_errors() {
    let e: JobError = sqlx::Error::RowNotFound.into();
    assert!(matches!(e, JobError::Unexpected(_)));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn missing_engine_and_fetcher_are_fatal_not_retried(pool: PgPool) {
    let c = ctx(&pool);
    assert!(matches!(c.engine(), Err(JobError::Fatal(_))));
    assert!(matches!(c.fetcher(), Err(JobError::Fatal(_))));
    assert!(matches!(c.files(), Err(JobError::Fatal(_))));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn with_engine_wires_engine_fetcher_and_files(pool: PgPool) {
    let dir = nimbus_testkit::tempdir();
    let mut cfg = nimbus_torrent::EngineConfig::new(dir.path(), false);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    let engine = Arc::new(nimbus_torrent::TorrentEngine::new(cfg).await.unwrap());
    let c = ctx(&pool).with_engine(engine.clone());
    assert!(c.engine().is_ok() && c.fetcher().is_ok() && c.files().is_ok());
    engine.shutdown().await;
}
