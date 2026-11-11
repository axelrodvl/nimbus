use std::sync::{Arc, RwLock};
use std::time::Duration;

use nimbus_core::config::Config;
use nimbus_core::model::TorrentSource;
use nimbus_core::settings::ProvidersSettings;

use crate::rutracker::{RutrackerOptions, RutrackerProvider};
use crate::torznab::TorznabProvider;
use crate::tpb::TpbProvider;
use crate::types::*;

pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(20);

/// Набор провайдеров; содержимое можно заменить на лету (`reload`) при изменении настроек.
pub struct ProviderRegistry {
    providers: RwLock<Vec<Arc<dyn TorrentProvider>>>,
    pub timeout: Duration,
}

pub type SearchOutcome = (TorrentSource, Result<Vec<TorrentCandidate>, ProviderError>);

impl ProviderRegistry {
    pub fn new(providers: Vec<Arc<dyn TorrentProvider>>) -> Self {
        Self {
            providers: RwLock::new(providers),
            timeout: PROVIDER_TIMEOUT,
        }
    }

    fn snapshot(&self) -> Vec<Arc<dyn TorrentProvider>> {
        self.providers.read().expect("providers lock").clone()
    }

    /// Источники включённых провайдеров.
    pub fn sources(&self) -> Vec<TorrentSource> {
        self.snapshot().iter().map(|p| p.source()).collect()
    }

    /// Заменяет набор провайдеров (HTTP-клиенты и сессии RuTracker создаются заново).
    pub fn reload(&self, settings: &ProvidersSettings) -> Result<(), ProviderError> {
        let providers = build_providers(settings)?;
        *self.providers.write().expect("providers lock") = providers;
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

    pub fn get(&self, source: TorrentSource) -> Option<Arc<dyn TorrentProvider>> {
        self.snapshot().into_iter().find(|p| p.source() == source)
    }

    /// Параллельный поиск по всем провайдерам; сбой одного не мешает остальным.
    pub async fn search_all(&self, q: &SearchQuery) -> Vec<SearchOutcome> {
        let timeout = self.timeout;
        futures::future::join_all(self.snapshot().into_iter().map(|p| async move {
            let source = p.source();
            let res = match tokio::time::timeout(timeout, p.search(q)).await {
                Ok(r) => r,
                Err(_) => Err(ProviderError::Timeout),
            };
            if let Err(e) = &res {
                tracing::warn!(?source, error = %e, "provider search failed");
            }
            (source, res)
        }))
        .await
    }
}

/// Собирает провайдеры из настроек: TPB — при `tpb_enabled`, Torznab — при заданном URL,
/// RuTracker — при заданных логине+пароле или cookie.
pub fn build_providers(
    settings: &ProvidersSettings,
) -> Result<Vec<Arc<dyn TorrentProvider>>, ProviderError> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; Nimbus/0.1)")
        .connect_timeout(Duration::from_secs(10))
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
                ..RutrackerOptions::default()
            })?));
        }
    }
    Ok(providers)
}
