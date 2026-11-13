//! The Pirate Bay через JSON-API apibay.

use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::model::{InfoHash, TorrentSource};
use serde::Deserialize;

use crate::limiter::{Limiter, FAST_INTERVAL};
use crate::magnet::{build_magnet, PUBLIC_TRACKERS};
use crate::types::*;

pub const DEFAULT_BASE_URL: &str = "https://apibay.org";
/// 100 — Audio (101 — Music, 104 — FLAC).
const AUDIO_CATEGORY: &str = "100";

pub struct TpbProvider {
    http: reqwest::Client,
    base_url: String,
    limiter: Limiter,
}

/// Все числа apibay отдаёт строками.
#[derive(Debug, Deserialize)]
struct Item {
    id: String,
    name: String,
    info_hash: String,
    #[serde(default)]
    leechers: String,
    #[serde(default)]
    seeders: String,
    #[serde(default)]
    num_files: String,
    #[serde(default)]
    size: String,
    #[serde(default)]
    category: String,
}

impl TpbProvider {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base_url(http, DEFAULT_BASE_URL)
    }

    pub fn with_base_url(http: reqwest::Client, base_url: &str) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            limiter: Limiter::new(FAST_INTERVAL),
        }
    }

    pub fn with_min_interval(mut self, interval: Duration) -> Self {
        self.limiter = Limiter::new(interval);
        self
    }

    fn parse(body: &str) -> Result<Vec<TorrentCandidate>, ProviderError> {
        let items: Vec<Item> =
            serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(items.into_iter().filter_map(Self::candidate).collect())
    }

    fn candidate(it: Item) -> Option<TorrentCandidate> {
        // Пустая выдача — один элемент с id=0 и "No results returned".
        if it.id == "0" || it.name == "No results returned" {
            return None;
        }
        let cat: u32 = it.category.parse().ok()?;
        if !(100..200).contains(&cat) {
            return None;
        }
        let hash = InfoHash::parse(&it.info_hash).ok()?;
        let magnet = build_magnet(&hash, &it.name, PUBLIC_TRACKERS);
        Some(TorrentCandidate {
            source: TorrentSource::Tpb,
            source_topic_id: Some(it.id),
            title: it.name,
            info_hash: Some(hash),
            magnet: Some(magnet),
            download_url: None,
            size_bytes: it.size.parse().ok(),
            seeders: it.seeders.parse().ok(),
            leechers: it.leechers.parse().ok(),
            category: Some(it.category),
            files_count: it.num_files.parse().ok().filter(|n| *n > 0),
            torrent_file: None,
        })
    }
}

#[async_trait]
impl TorrentProvider for TpbProvider {
    fn source(&self) -> TorrentSource {
        TorrentSource::Tpb
    }

    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        self.limiter.wait().await;
        let resp = self
            .http
            .get(format!("{}/q.php", self.base_url))
            .query(&[("q", q.text.as_str()), ("cat", AUDIO_CATEGORY)])
            .send()
            .await?;
        let body = check_status(resp)?.text().await?;
        Self::parse(&body)
    }
}
