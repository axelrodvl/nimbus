use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::future::{BoxFuture, FutureExt, Shared};
use nimbus_core::config::Config;
use nimbus_core::model::TorrentSource;
use nimbus_core::settings::ProvidersSettings;
use tokio::time::Instant;

use crate::rutracker::{RutrackerOptions, RutrackerProvider};
use crate::torznab::TorznabProvider;
use crate::tpb::TpbProvider;
use crate::types::*;

/// Таймаут одного поискового запроса к провайдеру: дольше 12 с ждать нет смысла —
/// медленный провайдер не должен тормозить остальных.
pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(12);
/// Таймаут установки соединения.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Сколько подряд неудач (уже после повторов внутри запроса) размыкают предохранитель.
/// Единичные сбои сети и 5xx — норма для публичных трекеров, они не должны выключать провайдера.
pub const BREAKER_THRESHOLD: u32 = 5;
/// Сколько раз повторяется запрос при временной ошибке (сеть, таймаут, 5xx), прежде чем считать его неудачей.
pub const REQUEST_RETRIES: u32 = 2;
/// Паузы между повторами одного запроса (растут вдвое).
pub const REQUEST_RETRY_DELAY: Duration = Duration::from_millis(300);
/// Паузы разомкнутого предохранителя: 1-е, 2-е, 3-е и последующие срабатывания подряд.
pub const BREAKER_PAUSES: [Duration; 4] = [
    Duration::from_secs(60),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(10 * 60),
];

/// Сколько хранится ответ провайдера на одинаковый запрос.
pub const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// Максимум записей кэша запросов (вытесняется давно не использованная).
pub const CACHE_CAPACITY: usize = 512;

type Found = Arc<Vec<TorrentCandidate>>;
type InFlight = Shared<BoxFuture<'static, Result<Found, ProviderError>>>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    source: TorrentSource,
    text: String,
    artist: Option<String>,
    album: Option<String>,
    year: Option<i32>,
}

impl CacheKey {
    fn new(source: TorrentSource, q: &SearchQuery) -> Self {
        let norm = |s: &str| {
            s.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        Self {
            source,
            text: norm(&q.text),
            artist: q.artist.as_deref().map(norm),
            album: q.album.as_deref().map(norm),
            year: q.year,
        }
    }
}

struct CacheEntry {
    found: Found,
    stored: Instant,
    used: u64,
}

#[derive(Default)]
struct Breaker {
    failures: u32,
    /// Сколько раз предохранитель срабатывал подряд (растёт пауза); сбрасывается успехом.
    trips: u32,
    open_until: Option<Instant>,
    /// Идёт пробный запрос после паузы (с какого момента) — остальные ждут его результата.
    probing: Option<Instant>,
    last_error: Option<String>,
}

#[derive(Default)]
struct State {
    /// Растёт при `reload`: результаты старых запросов не попадают в новые кэш и предохранители.
    epoch: u64,
    tick: u64,
    cache: HashMap<CacheKey, CacheEntry>,
    inflight: HashMap<CacheKey, InFlight>,
    breakers: HashMap<TorrentSource, Breaker>,
}

/// Состояние провайдера для `/api/health`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHealth {
    pub source: TorrentSource,
    /// `true` — предохранитель разомкнут, запросы не отправляются.
    pub open: bool,
    pub last_error: Option<String>,
    pub open_until: Option<DateTime<Utc>>,
}

/// Набор провайдеров; содержимое можно заменить на лету (`reload`) при изменении настроек.
/// Поверх провайдеров — предохранитель (на провайдера) и кэш одинаковых запросов с single-flight.
pub struct ProviderRegistry {
    providers: RwLock<Vec<Arc<dyn TorrentProvider>>>,
    pub timeout: Duration,
    /// Повторов временной ошибки внутри одного запроса.
    pub retries: u32,
    state: Arc<Mutex<State>>,
}

pub type SearchOutcome = (TorrentSource, Result<Vec<TorrentCandidate>, ProviderError>);

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Стоит ли повторить запрос сразу: сеть, таймаут, 5xx. Лимит (429), блокировка и авторизация — нет:
/// повтор только злит сайт.
fn is_transient(e: &ProviderError) -> bool {
    match e {
        ProviderError::Network(_) | ProviderError::Timeout => true,
        ProviderError::Blocked(m) => m.starts_with("HTTP 5"),
        _ => false,
    }
}

/// Запрос к провайдеру с таймаутом на каждую попытку и повторами временных ошибок.
async fn search_with_retries(
    provider: &dyn TorrentProvider,
    query: &SearchQuery,
    timeout: Duration,
    retries: u32,
) -> Result<Vec<TorrentCandidate>, ProviderError> {
    let mut delay = REQUEST_RETRY_DELAY;
    let mut attempt = 0;
    loop {
        let res = match tokio::time::timeout(timeout, provider.search(query)).await {
            Ok(r) => r,
            Err(_) => Err(ProviderError::Timeout),
        };
        match res {
            Err(e) if attempt < retries && is_transient(&e) => {
                tracing::debug!(error = %e, attempt, "provider request failed, retrying");
                tokio::time::sleep(delay).await;
                delay *= 2;
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// Считается ли ошибка признаком нездоровья провайдера (а не особенностью запроса).
fn counts_as_failure(e: &ProviderError) -> bool {
    matches!(
        e,
        ProviderError::Network(_)
            | ProviderError::Blocked(_)
            | ProviderError::Timeout
            | ProviderError::RateLimited
            | ProviderError::Auth(_)
    )
}

impl Breaker {
    /// Можно ли сейчас слать запрос; помечает пробный запрос после паузы.
    fn allow(&mut self, now: Instant, probe_timeout: Duration) -> bool {
        match self.open_until {
            None => true,
            Some(until) if now < until => false,
            Some(_) => match self.probing {
                Some(since) if now.duration_since(since) < probe_timeout => false,
                _ => {
                    self.probing = Some(now);
                    true
                }
            },
        }
    }

    fn success(&mut self) {
        *self = Breaker::default();
    }

    fn failure(&mut self, e: &ProviderError, now: Instant) {
        self.last_error = Some(e.to_string());
        let was_probe = self.probing.take().is_some();
        // Запросы, улетевшие до размыкания, возвращаются с ошибкой уже при разомкнутом
        // предохранителе: это не новое срабатывание и паузу они не удлиняют.
        if !was_probe && self.open_until.is_some_and(|u| now < u) {
            return;
        }
        self.failures += 1;
        // Ошибки авторизации (RuTracker) размыкают сразу: повторы только злят сайт.
        if was_probe || self.failures >= BREAKER_THRESHOLD || matches!(e, ProviderError::Auth(_)) {
            let pause = BREAKER_PAUSES[(self.trips as usize).min(BREAKER_PAUSES.len() - 1)];
            self.trips += 1;
            self.open_until = Some(now + pause);
            tracing::warn!(error = %e, ?pause, "provider circuit opened");
        }
    }
}

impl ProviderRegistry {
    pub fn new(providers: Vec<Arc<dyn TorrentProvider>>) -> Self {
        Self {
            providers: RwLock::new(providers),
            timeout: PROVIDER_TIMEOUT,
            retries: REQUEST_RETRIES,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    fn snapshot(&self) -> Vec<Arc<dyn TorrentProvider>> {
        self.providers
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Источники включённых провайдеров.
    pub fn sources(&self) -> Vec<TorrentSource> {
        self.snapshot().iter().map(|p| p.source()).collect()
    }

    /// Заменяет набор провайдеров (HTTP-клиенты и сессии RuTracker создаются заново);
    /// кэш запросов и предохранители сбрасываются.
    pub fn reload(&self, settings: &ProvidersSettings) -> Result<(), ProviderError> {
        let providers = build_providers(settings)?;
        *self
            .providers
            .write()
            .unwrap_or_else(PoisonError::into_inner) = providers;
        let mut st = lock(&self.state);
        st.epoch += 1;
        st.cache.clear();
        st.inflight.clear();
        st.breakers.clear();
        Ok(())
    }

    /// TPB — при `tpb_enabled`, Torznab — при заданном `torznab_url`,
    /// RuTracker — при заданных логине+пароле или cookie.
    pub fn from_config(config: &Config) -> Result<Self, ProviderError> {
        let settings = nimbus_core::Settings::from_config(config);
        Ok(Self::new(build_providers(&settings.providers)?))
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Сколько раз повторять запрос при временной ошибке (0 — не повторять).
    pub fn with_retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    pub fn get(&self, source: TorrentSource) -> Option<Arc<dyn TorrentProvider>> {
        self.snapshot().into_iter().find(|p| p.source() == source)
    }

    /// Состояние каждого включённого провайдера.
    pub fn health(&self) -> Vec<ProviderHealth> {
        let now = Instant::now();
        let st = lock(&self.state);
        self.sources()
            .into_iter()
            .map(|source| {
                let b = st.breakers.get(&source);
                let remaining = b
                    .and_then(|b| b.open_until)
                    .and_then(|u| u.checked_duration_since(now));
                ProviderHealth {
                    source,
                    open: remaining.is_some(),
                    last_error: b.and_then(|b| b.last_error.clone()),
                    open_until: remaining
                        .and_then(|r| chrono::Duration::from_std(r).ok())
                        .map(|r| Utc::now() + r),
                }
            })
            .collect()
    }

    /// Параллельный поиск по всем провайдерам; сбой одного не мешает остальным.
    pub async fn search_all(&self, q: &SearchQuery) -> Vec<SearchOutcome> {
        futures::future::join_all(self.snapshot().into_iter().map(|p| async move {
            let source = p.source();
            let res = self.search_one(p, q).await.map(|f| f.as_ref().clone());
            (source, res)
        }))
        .await
    }

    /// Один провайдер: кэш → общий запрос в полёте → предохранитель → сам запрос.
    async fn search_one(
        &self,
        provider: Arc<dyn TorrentProvider>,
        q: &SearchQuery,
    ) -> Result<Found, ProviderError> {
        let source = provider.source();
        let key = CacheKey::new(source, q);
        let now = Instant::now();
        let flight = {
            let mut st = lock(&self.state);
            st.tick += 1;
            let tick = st.tick;
            if let Some(e) = st.cache.get_mut(&key) {
                if now.duration_since(e.stored) < CACHE_TTL {
                    e.used = tick;
                    return Ok(e.found.clone());
                }
                st.cache.remove(&key);
            }
            if let Some(f) = st.inflight.get(&key) {
                f.clone()
            } else {
                let timeout = provider
                    .timeout_hint()
                    .map_or(self.timeout, |hint| hint.max(self.timeout));
                let retries = self.retries;
                let allowed = st
                    .breakers
                    .entry(source)
                    .or_default()
                    .allow(now, timeout * (retries + 1) + Duration::from_secs(5));
                if !allowed {
                    return Err(ProviderError::CircuitOpen);
                }
                let epoch = st.epoch;
                let state = Arc::clone(&self.state);
                let (k, query) = (key.clone(), q.clone());
                // Поиск идёт отдельной задачей, а не «общим будущим», которое двигают только ожидающие:
                // если все ожидающие ушли (запрос отменён), будущее зависло бы в `inflight` навсегда.
                // Задача ограничена таймаутом провайдера, поэтому отдельно её не отслеживаем.
                let task = tokio::spawn(async move {
                    let res = search_with_retries(provider.as_ref(), &query, timeout, retries)
                        .await
                        .map(Arc::new);
                    let mut st = lock(&state);
                    if st.epoch == epoch {
                        st.inflight.remove(&k);
                        match &res {
                            Ok(found) => {
                                st.breakers.entry(source).or_default().success();
                                st.tick += 1;
                                let used = st.tick;
                                st.cache.insert(
                                    k,
                                    CacheEntry {
                                        found: found.clone(),
                                        stored: Instant::now(),
                                        used,
                                    },
                                );
                                if st.cache.len() > CACHE_CAPACITY {
                                    let oldest = st
                                        .cache
                                        .iter()
                                        .min_by_key(|(_, e)| e.used)
                                        .map(|(k, _)| k.clone());
                                    if let Some(o) = oldest {
                                        st.cache.remove(&o);
                                    }
                                }
                            }
                            Err(e) if counts_as_failure(e) => {
                                st.breakers
                                    .entry(source)
                                    .or_default()
                                    .failure(e, Instant::now());
                            }
                            // Не признак нездоровья (напр. разбор): пробный запрос, если он был,
                            // закончен — не держим остальных за «закрытой дверью».
                            Err(_) => {
                                st.breakers.entry(source).or_default().probing = None;
                            }
                        }
                    }
                    drop(st);
                    if let Err(e) = &res {
                        tracing::warn!(?source, error = %e, "provider search failed");
                    }
                    res
                });
                let fut: BoxFuture<'static, _> = async move {
                    task.await.unwrap_or_else(|e| {
                        Err(ProviderError::Network(format!("search task failed: {e}")))
                    })
                }
                .boxed();
                let shared = fut.shared();
                st.inflight.insert(key, shared.clone());
                shared
            }
        };
        flight.await
    }
}

/// Собирает провайдеры из настроек: TPB — при `tpb_enabled`, Torznab — при заданном URL,
/// RuTracker — при заданных логине+пароле или cookie.
pub fn build_providers(
    settings: &ProvidersSettings,
) -> Result<Vec<Arc<dyn TorrentProvider>>, ProviderError> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; Nimbus/0.1)")
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(PROVIDER_TIMEOUT)
        .build()
        .map_err(ProviderError::from)?;
    let mut providers: Vec<Arc<dyn TorrentProvider>> = Vec::new();
    if settings.tpb_enabled {
        providers.push(Arc::new(TpbProvider::new(http.clone())));
    }
    if let Some(t) = settings
        .torznab
        .as_ref()
        .filter(|t| !t.url.trim().is_empty())
    {
        let key = t.api_key.as_deref().unwrap_or("");
        providers.push(Arc::new(TorznabProvider::new(http.clone(), &t.url, key)));
    }
    if let Some(r) = &settings.rutracker {
        let has_creds = r.username.is_some() && r.password.is_some();
        if has_creds || r.cookie.is_some() {
            providers.push(Arc::new(RutrackerProvider::new(RutrackerOptions {
                username: r.username.clone(),
                password: r.password.clone(),
                cookie: r.cookie.clone(),
                proxy: r.proxy.clone(),
                user_agent: r.user_agent.clone(),
                headers: r.headers.clone(),
                flaresolverr_url: r.flaresolverr_url.clone(),
                ..RutrackerOptions::default()
            })?));
        }
    }
    Ok(providers)
}
