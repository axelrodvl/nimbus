//! Torznab (Jackett / Prowlarr): RSS-ответ с `<torznab:attr>`.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::model::{InfoHash, TorrentSource};
use serde::Deserialize;

use crate::limiter::{Limiter, TORZNAB_CONCURRENCY, TORZNAB_INTERVAL};
use crate::torrent_file::info_hash_of_torrent;
use crate::types::*;

pub struct TorznabProvider {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    limiter: Limiter,
}

#[derive(Debug, Deserialize)]
struct Rss {
    channel: Channel,
}
#[derive(Debug, Deserialize)]
struct Channel {
    #[serde(rename = "item", default)]
    items: Vec<Item>,
}
#[derive(Debug, Deserialize)]
struct Item {
    title: String,
    #[serde(default)]
    guid: Option<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    enclosure: Option<Enclosure>,
    // quick-xml сопоставляет по локальному имени: `torznab:attr` -> `attr`.
    #[serde(rename = "attr", default)]
    attrs: Vec<Attr>,
}
#[derive(Debug, Deserialize)]
struct Enclosure {
    #[serde(rename = "@url")]
    url: String,
}
#[derive(Debug, Deserialize)]
struct Attr {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@value")]
    value: String,
}
/// `<error code="100" description="Incorrect user credentials"/>`
#[derive(Debug, Deserialize)]
struct ErrorDoc {
    #[serde(rename = "@code")]
    code: String,
    #[serde(rename = "@description", default)]
    description: String,
}

impl TorznabProvider {
    pub fn new(http: reqwest::Client, base_url: &str, api_key: &str) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            limiter: Limiter::new(TORZNAB_INTERVAL, TORZNAB_CONCURRENCY),
        }
    }

    pub fn with_min_interval(mut self, interval: Duration) -> Self {
        self.limiter = Limiter::new(interval, TORZNAB_CONCURRENCY);
        self
    }

    async fn fetch(&self, params: &[(&str, &str)]) -> Result<Vec<TorrentCandidate>, ProviderError> {
        let _permit = self.limiter.acquire().await;
        let mut query: Vec<(&str, &str)> = params.to_vec();
        query.push(("apikey", &self.api_key));
        query.push(("extended", "1"));
        let resp = self
            .http
            .get(format!("{}/api", self.base_url))
            .query(&query)
            .send()
            .await?;
        let body = check_status(resp)?.text().await?;
        Self::parse(&body)
    }

    pub(crate) fn parse(body: &str) -> Result<Vec<TorrentCandidate>, ProviderError> {
        if let Ok(err) = quick_xml::de::from_str::<ErrorDoc>(body) {
            return Err(match err.code.parse::<u32>() {
                Ok(100..=199) => ProviderError::Auth(err.description),
                _ => {
                    ProviderError::Parse(format!("torznab error {}: {}", err.code, err.description))
                }
            });
        }
        let rss: Rss =
            quick_xml::de::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(rss.channel.items.into_iter().map(Self::candidate).collect())
    }

    fn candidate(it: Item) -> TorrentCandidate {
        let attrs: HashMap<&str, &str> = it
            .attrs
            .iter()
            .map(|a| (a.name.as_str(), a.value.as_str()))
            .collect();
        let num = |k: &str| attrs.get(k).and_then(|v| v.parse::<u32>().ok());

        let magnet = attrs
            .get("magneturl")
            .map(|s| s.to_string())
            .or_else(|| it.link.clone().filter(|l| l.starts_with("magnet:")))
            .or_else(|| {
                it.enclosure
                    .as_ref()
                    .map(|e| e.url.clone())
                    .filter(|u| u.starts_with("magnet:"))
            });
        let info_hash = attrs
            .get("infohash")
            .and_then(|h| InfoHash::parse(h).ok())
            .or_else(|| magnet.as_deref().and_then(InfoHash::from_magnet));
        let download_url = it
            .enclosure
            .map(|e| e.url)
            .or(it.link)
            .filter(|u| u.starts_with("http"));

        let seeders = num("seeders");
        let leechers = match (num("peers"), seeders) {
            (Some(p), Some(s)) => Some(p.saturating_sub(s)),
            _ => None,
        };
        TorrentCandidate {
            source: TorrentSource::Torznab,
            source_topic_id: it.guid,
            title: it.title,
            info_hash,
            magnet,
            download_url,
            size_bytes: it
                .size
                .or_else(|| attrs.get("size").and_then(|v| v.parse().ok())),
            seeders,
            leechers,
            category: attrs.get("category").map(|c| c.to_string()),
            files_count: num("files"),
            torrent_file: None,
        }
    }
}

#[async_trait]
impl TorrentProvider for TorznabProvider {
    fn source(&self) -> TorrentSource {
        TorrentSource::Torznab
    }

    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        if let (Some(artist), Some(album)) = (&q.artist, &q.album) {
            let found = self
                .fetch(&[("t", "music"), ("artist", artist), ("album", album)])
                .await?;
            if !found.is_empty() {
                return Ok(found);
            }
        }
        self.fetch(&[("t", "search"), ("q", &q.text), ("cat", "3000")])
            .await
    }

    /// Для кандидатов с одной `.torrent`-ссылкой скачивает файл и считает info-hash.
    async fn resolve(&self, mut c: TorrentCandidate) -> Result<TorrentCandidate, ProviderError> {
        if c.info_hash.is_some() {
            return Ok(c);
        }
        let Some(url) = c.download_url.clone() else {
            return Ok(c);
        };
        let _permit = self.limiter.acquire().await;
        let resp = self.http.get(&url).send().await?;
        let bytes = check_status(resp)?.bytes().await?;
        let hash = info_hash_of_torrent(&bytes)
            .ok_or_else(|| ProviderError::Parse("not a valid .torrent file".into()))?;
        // Готовый `.torrent` кладём в кандидата: список файлов будет известен без сети.
        if bytes.len() <= nimbus_core::model::MAX_TORRENT_FILE_BYTES {
            c.torrent_file = Some(bytes.to_vec());
        } else {
            tracing::warn!(size = bytes.len(), "torrent file is too large, not kept");
        }
        c.magnet = Some(crate::magnet::build_magnet(
            &hash,
            &c.title,
            crate::magnet::PUBLIC_TRACKERS,
        ));
        c.info_hash = Some(hash);
        Ok(c)
    }
}
