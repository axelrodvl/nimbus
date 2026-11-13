// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Лимитер (темп + параллелизм), предохранитель и кэш запросов `ProviderRegistry`.
//! Время — `tokio::time::pause` (`start_paused`), без реальных пауз.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::model::TorrentSource;
use nimbus_trackers::limiter::Limiter;
use nimbus_trackers::registry::{BREAKER_PAUSES, BREAKER_THRESHOLD, CACHE_CAPACITY, CACHE_TTL};
use nimbus_trackers::*;
use tokio::time::Instant;

// ------------------------------------------------------------------ лимитер

#[tokio::test(start_paused = true)]
async fn limiter_caps_concurrency() {
    let limiter = Arc::new(Limiter::new(Duration::from_millis(1), 2));
    let (now, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let (l, now, peak) = (limiter.clone(), now.clone(), peak.clone());
            tokio::spawn(async move {
                let _permit = l.acquire().await;
                let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                now.fetch_sub(1, Ordering::SeqCst);
            })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(peak.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn limiter_keeps_min_interval_between_starts() {
    let limiter = Limiter::new(Duration::from_secs(1), 10);
    let t0 = Instant::now();
    let mut starts = vec![];
    for _ in 0..4 {
        let _p = limiter.acquire().await;
        starts.push(Instant::now() - t0);
    }
    for (i, s) in starts.iter().enumerate() {
        assert_eq!(*s, Duration::from_secs(i as u64), "start #{i}");
    }
}

#[tokio::test(start_paused = true)]
async fn limiter_cancelled_waiter_releases_its_place() {
    let limiter = Arc::new(Limiter::new(Duration::from_millis(1), 1));
    let held = limiter.acquire().await;
    // Ожидающий отменён по таймауту — место не должно «утечь».
    assert!(
        tokio::time::timeout(Duration::from_millis(10), limiter.acquire())
            .await
            .is_err()
    );
    drop(held);
    let _permit = tokio::time::timeout(Duration::from_secs(1), limiter.acquire())
        .await
        .expect("place is free again");
}

// ------------------------------------------------------------ фейк-провайдер

struct Scripted {
    source: TorrentSource,
    calls: AtomicUsize,
    /// Ответы по очереди; когда кончились — пустой успех.
    script: Mutex<VecDeque<Result<usize, ProviderError>>>,
    delay: Duration,
}

impl Scripted {
    fn new(source: TorrentSource, script: Vec<Result<usize, ProviderError>>) -> Arc<Self> {
        Arc::new(Self {
            source,
            calls: AtomicUsize::new(0),
            script: Mutex::new(script.into()),
            delay: Duration::ZERO,
        })
    }
    fn slow(source: TorrentSource, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            source,
            calls: AtomicUsize::new(0),
            script: Mutex::new(VecDeque::new()),
            delay,
        })
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn candidate(n: usize) -> TorrentCandidate {
    TorrentCandidate {
        source: TorrentSource::Tpb,
        source_topic_id: Some(n.to_string()),
        title: format!("t{n}"),
        info_hash: None,
        magnet: None,
        download_url: None,
        size_bytes: None,
        seeders: None,
        leechers: None,
        category: None,
        files_count: None,
        torrent_file: None,
    }
}

#[async_trait]
impl TorrentProvider for Scripted {
    fn source(&self) -> TorrentSource {
        self.source
    }
    async fn search(&self, _q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        let next = self.script.lock().unwrap().pop_front();
        next.unwrap_or(Ok(1))
            .map(|n| (0..n).map(candidate).collect())
    }
}

fn blocked() -> Result<usize, ProviderError> {
    Err(ProviderError::Blocked("HTTP 503".into()))
}

async fn search(
    reg: &ProviderRegistry,
    text: &str,
) -> Result<Vec<TorrentCandidate>, ProviderError> {
    reg.search_all(&SearchQuery::text(text))
        .await
        .into_iter()
        .next()
        .unwrap()
        .1
}

// ------------------------------------------------------------ предохранитель

#[tokio::test(start_paused = true)]
async fn breaker_opens_after_three_failures_and_skips_http() {
    let p = Scripted::new(TorrentSource::Tpb, vec![blocked(); 10]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..BREAKER_THRESHOLD {
        assert!(matches!(
            search(&reg, &format!("q{i}")).await,
            Err(ProviderError::Blocked(_))
        ));
    }
    assert_eq!(p.calls(), 3);
    assert!(matches!(
        search(&reg, "q-next").await,
        Err(ProviderError::CircuitOpen)
    ));
    assert_eq!(p.calls(), 3, "open breaker must not call the provider");

    let h = reg.health();
    assert_eq!(h.len(), 1);
    assert!(h[0].open && h[0].open_until.is_some());
    assert!(h[0].last_error.as_deref().unwrap().contains("503"));
}

#[tokio::test(start_paused = true)]
async fn breaker_probes_after_pause_and_success_closes_it() {
    let mut script = vec![blocked(); 3];
    script.push(Ok(2));
    let p = Scripted::new(TorrentSource::Tpb, script);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..3 {
        let _ = search(&reg, &format!("q{i}")).await;
    }
    tokio::time::advance(BREAKER_PAUSES[0] - Duration::from_secs(1)).await;
    assert!(matches!(
        search(&reg, "early").await,
        Err(ProviderError::CircuitOpen)
    ));
    tokio::time::advance(Duration::from_secs(2)).await;
    assert_eq!(search(&reg, "probe").await.unwrap().len(), 2);
    assert_eq!(p.calls(), 4);
    assert!(!reg.health()[0].open);
    // Замкнут: дальше запросы идут обычно.
    assert!(search(&reg, "after").await.is_ok());
    assert_eq!(p.calls(), 5);
}

#[tokio::test(start_paused = true)]
async fn breaker_pause_grows_when_probe_fails() {
    let p = Scripted::new(TorrentSource::Tpb, vec![blocked(); 20]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..3 {
        let _ = search(&reg, &format!("q{i}")).await;
    }
    // Первая пауза — 60 с; пробный запрос падает → вторая пауза — 2 мин.
    tokio::time::advance(BREAKER_PAUSES[0] + Duration::from_secs(1)).await;
    assert!(matches!(
        search(&reg, "probe1").await,
        Err(ProviderError::Blocked(_))
    ));
    assert_eq!(p.calls(), 4);
    tokio::time::advance(BREAKER_PAUSES[0] + Duration::from_secs(1)).await;
    assert!(matches!(
        search(&reg, "still-open").await,
        Err(ProviderError::CircuitOpen)
    ));
    tokio::time::advance(BREAKER_PAUSES[1]).await;
    assert!(matches!(
        search(&reg, "probe2").await,
        Err(ProviderError::Blocked(_))
    ));
    assert_eq!(p.calls(), 5);
}

#[tokio::test(start_paused = true)]
async fn auth_error_opens_breaker_immediately() {
    let p = Scripted::new(
        TorrentSource::Rutracker,
        vec![Err(ProviderError::Auth("captcha".into()))],
    );
    let reg = ProviderRegistry::new(vec![p.clone()]);
    assert!(matches!(
        search(&reg, "a").await,
        Err(ProviderError::Auth(_))
    ));
    assert!(matches!(
        search(&reg, "b").await,
        Err(ProviderError::CircuitOpen)
    ));
    assert_eq!(p.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn success_resets_failure_streak_and_breakers_are_per_provider() {
    let flaky = Scripted::new(
        TorrentSource::Tpb,
        vec![blocked(), blocked(), Ok(1), blocked(), blocked()],
    );
    let other = Scripted::new(TorrentSource::Torznab, vec![blocked(); 5]);
    let reg = ProviderRegistry::new(vec![flaky.clone(), other.clone()]);
    for i in 0..5 {
        let _ = reg.search_all(&SearchQuery::text(format!("q{i}"))).await;
    }
    // У flaky серия оборвалась успехом — не разомкнут; у other — 3 подряд.
    let res = reg.search_all(&SearchQuery::text("last")).await;
    assert_eq!(flaky.calls(), 6);
    assert!(matches!(res[1].1, Err(ProviderError::CircuitOpen)));
    assert_eq!(other.calls(), 3);
}

#[tokio::test(start_paused = true)]
async fn parse_errors_do_not_open_breaker() {
    let p = Scripted::new(
        TorrentSource::Tpb,
        (0..5)
            .map(|_| Err(ProviderError::Parse("bad".into())))
            .collect(),
    );
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..5 {
        assert!(matches!(
            search(&reg, &format!("q{i}")).await,
            Err(ProviderError::Parse(_))
        ));
    }
    assert_eq!(p.calls(), 5);
}

#[tokio::test(start_paused = true)]
async fn timeout_counts_as_failure() {
    let p = Scripted::slow(TorrentSource::Tpb, Duration::from_secs(3600));
    let reg = ProviderRegistry::new(vec![p.clone()]).with_timeout(Duration::from_secs(1));
    for i in 0..3 {
        assert!(matches!(
            search(&reg, &format!("q{i}")).await,
            Err(ProviderError::Timeout)
        ));
    }
    assert!(matches!(
        search(&reg, "q").await,
        Err(ProviderError::CircuitOpen)
    ));
}

#[test]
fn reload_resets_breakers_and_cache() {
    let settings = nimbus_core::Settings::from_config(
        &nimbus_core::config::Config::from_map(&std::collections::HashMap::from([(
            "DATABASE_URL",
            "postgres://x",
        )]))
        .unwrap(),
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    rt.block_on(async {
        let reg =
            ProviderRegistry::new(vec![Scripted::new(TorrentSource::Tpb, vec![blocked(); 5])]);
        for i in 0..3 {
            let _ = search(&reg, &format!("q{i}")).await;
        }
        assert!(reg.health()[0].open);
        reg.reload(&settings.providers).unwrap();
        // После reload набор — из настроек (TPB), состояние чистое.
        let h = reg.health();
        assert_eq!(h.len(), 1);
        assert!(!h[0].open && h[0].last_error.is_none());
    });
}

// ----------------------------------------------------------------------- кэш

#[tokio::test(start_paused = true)]
async fn identical_queries_hit_the_provider_once() {
    let p = Scripted::new(TorrentSource::Tpb, vec![Ok(3)]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    assert_eq!(search(&reg, "Artist Album").await.unwrap().len(), 3);
    // Нормализация: регистр и пробелы не важны.
    assert_eq!(search(&reg, "  artist   ALBUM ").await.unwrap().len(), 3);
    assert_eq!(p.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn cache_entry_expires_after_ttl() {
    let p = Scripted::new(TorrentSource::Tpb, vec![Ok(1), Ok(2)]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    assert_eq!(search(&reg, "q").await.unwrap().len(), 1);
    tokio::time::advance(CACHE_TTL + Duration::from_secs(1)).await;
    assert_eq!(search(&reg, "q").await.unwrap().len(), 2);
    assert_eq!(p.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn concurrent_identical_queries_are_single_flight() {
    let p = Scripted::slow(TorrentSource::Tpb, Duration::from_secs(1));
    let reg = ProviderRegistry::new(vec![p.clone()]);
    let q = SearchQuery::text("same");
    let (a, b, c) = tokio::join!(reg.search_all(&q), reg.search_all(&q), reg.search_all(&q));
    assert_eq!(p.calls(), 1);
    for r in [a, b, c] {
        assert_eq!(r[0].1.as_ref().unwrap().len(), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn providers_do_not_share_cache() {
    let a = Scripted::new(TorrentSource::Tpb, vec![]);
    let b = Scripted::new(TorrentSource::Torznab, vec![]);
    let reg = ProviderRegistry::new(vec![a.clone(), b.clone()]);
    reg.search_all(&SearchQuery::text("q")).await;
    reg.search_all(&SearchQuery::text("q")).await;
    assert_eq!((a.calls(), b.calls()), (1, 1));
}

#[tokio::test(start_paused = true)]
async fn structured_query_fields_are_part_of_the_key() {
    let p = Scripted::new(TorrentSource::Torznab, vec![]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    let mut q = SearchQuery::text("q");
    reg.search_all(&q).await;
    q.artist = Some("A".into());
    q.album = Some("B".into());
    reg.search_all(&q).await;
    assert_eq!(p.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn errors_are_not_cached() {
    let p = Scripted::new(TorrentSource::Tpb, vec![blocked(), Ok(1)]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    assert!(search(&reg, "q").await.is_err());
    assert_eq!(search(&reg, "q").await.unwrap().len(), 1);
    assert_eq!(p.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn cache_is_bounded_lru() {
    let p = Scripted::new(TorrentSource::Tpb, vec![]);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..CACHE_CAPACITY + 10 {
        search(&reg, &format!("q{i}")).await.unwrap();
    }
    assert_eq!(p.calls(), CACHE_CAPACITY + 10);
    // Свежие записи на месте, самые старые вытеснены.
    search(&reg, &format!("q{}", CACHE_CAPACITY + 9))
        .await
        .unwrap();
    assert_eq!(p.calls(), CACHE_CAPACITY + 10);
    search(&reg, "q0").await.unwrap();
    assert_eq!(p.calls(), CACHE_CAPACITY + 11);
}

#[tokio::test(start_paused = true)]
async fn parse_error_during_probe_does_not_block_following_probes() {
    let mut script = vec![blocked(); 3];
    script.push(Err(ProviderError::Parse("bad".into())));
    script.push(Ok(1));
    let p = Scripted::new(TorrentSource::Tpb, script);
    let reg = ProviderRegistry::new(vec![p.clone()]);
    for i in 0..3 {
        let _ = search(&reg, &format!("q{i}")).await;
    }
    tokio::time::advance(BREAKER_PAUSES[0] + Duration::from_secs(1)).await;
    assert!(matches!(
        search(&reg, "probe").await,
        Err(ProviderError::Parse(_))
    ));
    // Пробный запрос закончился (не отказом) — следующий сразу идёт к провайдеру.
    assert!(search(&reg, "next").await.is_ok());
    assert_eq!(p.calls(), 5);
}
