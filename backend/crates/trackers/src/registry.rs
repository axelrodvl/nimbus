use std::sync::Arc;
use std::time::Duration;

use nimbus_core::config::Config;
use nimbus_core::model::TorrentSource;

use crate::torznab::TorznabProvider;
use crate::tpb::TpbProvider;
use crate::types::*;

pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(20);

pub struct ProviderRegistry {
    pub providers: Vec<Arc<dyn TorrentProvider>>,
    pub timeout: Duration,
}

pub type SearchOutcome = (TorrentSource, Result<Vec<TorrentCandidate>, ProviderError>);

impl ProviderRegistry {
    pub fn new(providers: Vec<Arc<dyn TorrentProvider>>) -> Self {
        Self {
            providers,
            timeout: PROVIDER_TIMEOUT,
        }
    }

    /// TPB — при `tpb_enabled`, Torznab — при заданном `torznab_url`. RuTracker — шаг 13.
    pub fn from_config(config: &Config) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; Nimbus/0.1)")
            .connect_timeout(Duration::from_secs(10))
            .timeout(PROVIDER_TIMEOUT)
            .build()?;
        let mut providers: Vec<Arc<dyn TorrentProvider>> = Vec::new();
        if config.tpb_enabled {
            providers.push(Arc::new(TpbProvider::new(http.clone())));
        }
        if let Some(url) = &config.torznab_url {
            let key = config.torznab_api_key.as_deref().unwrap_or("");
            providers.push(Arc::new(TorznabProvider::new(http.clone(), url, key)));
        }
        Ok(Self::new(providers))
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn get(&self, source: TorrentSource) -> Option<&Arc<dyn TorrentProvider>> {
        self.providers.iter().find(|p| p.source() == source)
    }

    /// Параллельный поиск по всем провайдерам; сбой одного не мешает остальным.
    pub async fn search_all(&self, q: &SearchQuery) -> Vec<SearchOutcome> {
        let timeout = self.timeout;
        futures::future::join_all(self.providers.iter().map(|p| async move {
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
