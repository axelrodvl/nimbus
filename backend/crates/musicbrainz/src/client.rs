use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use nimbus_db::repo::mb_cache;
use nimbus_db::PgPool;
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use uuid::Uuid;

use crate::canonical::pick_canonical;
use crate::error::{MbError, Result};
use crate::limiter::Limiter;
use crate::lucene::search_query;
use crate::model::*;

pub const SEARCH_TTL: Duration = Duration::from_secs(24 * 3600);
pub const LOOKUP_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

const MAX_RETRIES: u32 = 3;
const PAGE_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Запросы пользователя (поиск, открытие страницы): обходят фоновую очередь.
    Interactive,
    /// Массовые фоновые lookup'ы (добавление артиста с десятками альбомов).
    Background,
}

#[derive(Debug, Clone)]
pub struct MbConfig {
    pub base: Url,
    pub user_agent: String,
    /// Минимальный интервал между запросами (по правилам MB — ~1 с; с запасом 1.1 с).
    pub min_interval: Duration,
    /// Пауза перед повтором при 503/429, если нет `Retry-After`.
    pub retry_delay: Duration,
    pub timeout: Duration,
}

impl MbConfig {
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            base: Url::parse("https://musicbrainz.org/ws/2/").expect("valid url"),
            user_agent: user_agent.into(),
            min_interval: Duration::from_millis(1100),
            retry_delay: Duration::from_secs(2),
            timeout: Duration::from_secs(15),
        }
    }
}

type Flight = Shared<BoxFuture<'static, Result<Arc<Value>>>>;

struct Inner {
    http: reqwest::Client,
    cfg: MbConfig,
    limiter: Limiter,
    cache: Option<PgPool>,
    inflight: Mutex<HashMap<String, Flight>>,
}

/// Клиент MusicBrainz. Дёшево клонируется; клоны делят лимитер, кэш и single-flight.
#[derive(Clone)]
pub struct MbClient {
    inner: Arc<Inner>,
    priority: Priority,
}

impl MbClient {
    /// Клиент с настройками по умолчанию; `cache` — пул БД для таблицы `mb_cache`.
    pub fn new(user_agent: &str, cache: Option<PgPool>) -> Result<Self> {
        Self::with_config(MbConfig::new(user_agent), cache)
    }

    pub fn with_config(cfg: MbConfig, cache: Option<PgPool>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(cfg.user_agent.clone())
            .timeout(cfg.timeout)
            .gzip(true)
            .build()
            .map_err(|e| MbError::Transport(e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Inner {
                http,
                limiter: Limiter::new(cfg.min_interval),
                cfg,
                cache,
                inflight: Mutex::new(HashMap::new()),
            }),
            priority: Priority::Interactive,
        })
    }

    /// Клон с фоновым приоритетом (для массовых lookup'ов из задач).
    pub fn background(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            priority: Priority::Background,
        }
    }

    pub fn priority(&self) -> Priority {
        self.priority
    }

    // ---------------------------------------------------------------- транспорт

    /// GET `path` с `fmt=json`: кэш → single-flight → лимитер → HTTP (повторы при 503/429) → кэш.
    pub async fn get_json(
        &self,
        path: &str,
        query: &[(&str, &str)],
        ttl: Duration,
    ) -> Result<Value> {
        let key = cache_key(path, query);

        if let Some(pool) = &self.inner.cache {
            match mb_cache::get(pool, &key).await {
                Ok(Some(v)) => return Ok(v),
                Ok(None) => {}
                Err(e) => tracing::warn!(error = %e, "mb_cache read failed"),
            }
        }

        let flight = {
            let mut map = self.inner.inflight.lock().unwrap();
            match map.get(&key) {
                Some(f) => f.clone(),
                None => {
                    let inner = self.inner.clone();
                    let priority = self.priority;
                    let owned_query: Vec<(String, String)> = query
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect();
                    let (path, k) = (path.to_string(), key.clone());
                    let fut = async move {
                        let r = inner
                            .fetch_and_cache(priority, &path, &owned_query, ttl, &k)
                            .await;
                        inner.inflight.lock().unwrap().remove(&k);
                        r.map(Arc::new)
                    }
                    .boxed()
                    .shared();
                    map.insert(key, fut.clone());
                    fut
                }
            }
        };
        flight.await.map(|v| (*v).clone())
    }

    async fn get_typed<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        ttl: Duration,
    ) -> Result<T> {
        let v = self.get_json(path, query, ttl).await?;
        serde_json::from_value(v).map_err(|e| MbError::Parse(format!("{path}: {e}")))
    }

    // ---------------------------------------------------------------- поиск

    pub async fn search_artists(&self, q: &str, limit: u8) -> Result<Vec<ArtistHit>> {
        let Some(query) = search_query(q) else {
            return Ok(vec![]);
        };
        let limit = limit_str(limit);
        let r: SearchArtists = self
            .get_typed(
                "artist",
                &[("query", &query), ("limit", &limit)],
                SEARCH_TTL,
            )
            .await?;
        Ok(r.artists.into_iter().map(Into::into).collect())
    }

    pub async fn search_release_groups(&self, q: &str, limit: u8) -> Result<Vec<ReleaseGroupHit>> {
        let Some(query) = search_query(q) else {
            return Ok(vec![]);
        };
        let limit = limit_str(limit);
        let r: SearchReleaseGroups = self
            .get_typed(
                "release-group",
                &[("query", &query), ("limit", &limit)],
                SEARCH_TTL,
            )
            .await?;
        r.release_groups
            .into_iter()
            .map(|g| g.into_hit(None))
            .collect()
    }

    pub async fn search_recordings(&self, q: &str, limit: u8) -> Result<Vec<RecordingHit>> {
        let Some(query) = search_query(q) else {
            return Ok(vec![]);
        };
        let limit = limit_str(limit);
        let r: SearchRecordings = self
            .get_typed(
                "recording",
                &[("query", &query), ("limit", &limit)],
                SEARCH_TTL,
            )
            .await?;
        r.recordings.into_iter().map(|x| x.into_hit()).collect()
    }

    // ---------------------------------------------------------------- lookup / browse

    pub async fn artist(&self, mbid: Uuid) -> Result<ArtistHit> {
        let r: RawArtist = self
            .get_typed(&format!("artist/{mbid}"), &[], LOOKUP_TTL)
            .await?;
        Ok(r.into())
    }

    pub async fn release_group(&self, mbid: Uuid) -> Result<ReleaseGroupHit> {
        let r: RawReleaseGroup = self
            .get_typed(
                &format!("release-group/{mbid}"),
                &[("inc", "artist-credits")],
                LOOKUP_TTL,
            )
            .await?;
        r.into_hit(None)
    }

    /// Запись по MBID (с релизами и их release group'ами — для выбора «альбома» записи).
    pub async fn recording(&self, mbid: Uuid) -> Result<RecordingHit> {
        let r: RawRecording = self
            .get_typed(
                &format!("recording/{mbid}"),
                &[("inc", "artist-credits releases release-groups")],
                LOOKUP_TTL,
            )
            .await?;
        r.into_hit()
    }

    /// Все release group'ы артиста указанных типов (`album`, `ep`, ...), с пагинацией по 100.
    pub async fn artist_release_groups(
        &self,
        artist: Uuid,
        types: &[&str],
    ) -> Result<Vec<ReleaseGroupHit>> {
        let artist_s = artist.to_string();
        let types_s = types.join("|");
        let limit = PAGE_LIMIT.to_string();
        let mut out = Vec::new();
        let mut offset = 0usize;
        loop {
            let off = offset.to_string();
            let mut query = vec![
                ("artist", artist_s.as_str()),
                ("inc", "artist-credits"),
                ("limit", limit.as_str()),
                ("offset", off.as_str()),
            ];
            if !types_s.is_empty() {
                query.push(("type", types_s.as_str()));
            }
            let page: BrowseReleaseGroups =
                self.get_typed("release-group", &query, LOOKUP_TTL).await?;
            let got = page.release_groups.len();
            for g in page.release_groups {
                out.push(g.into_hit(Some(artist))?);
            }
            offset += got;
            if got == 0 || offset >= page.count {
                break;
            }
        }
        Ok(out)
    }

    /// Каноничный релиз группы (см. `canonical::score_release`).
    pub async fn pick_canonical_release(&self, release_group: Uuid) -> Result<Uuid> {
        let rg = release_group.to_string();
        let limit = PAGE_LIMIT.to_string();
        let base = [
            ("release-group", rg.as_str()),
            ("inc", "media"),
            ("limit", limit.as_str()),
        ];

        let mut official = base.to_vec();
        official.push(("status", "official"));
        let mut page: BrowseReleases = self.get_typed("release", &official, LOOKUP_TTL).await?;
        if page.releases.is_empty() {
            page = self.get_typed("release", &base, LOOKUP_TTL).await?;
        }
        let briefs: Vec<_> = page.releases.into_iter().map(|r| r.into_brief()).collect();
        pick_canonical(&briefs)
            .map(|r| r.mbid)
            .ok_or(MbError::NotFound)
    }

    pub async fn release_tracklist(&self, release: Uuid) -> Result<ReleaseTracklist> {
        let r: RawReleaseFull = self
            .get_typed(
                &format!("release/{release}"),
                &[("inc", "recordings artist-credits")],
                LOOKUP_TTL,
            )
            .await?;
        Ok(r.into())
    }
}

impl Inner {
    async fn fetch_and_cache(
        &self,
        priority: Priority,
        path: &str,
        query: &[(String, String)],
        ttl: Duration,
        key: &str,
    ) -> Result<Value> {
        let value = self.fetch(priority, path, query).await?;
        if let Some(pool) = &self.cache {
            if let Err(e) = mb_cache::put(pool, key, &value, ttl).await {
                tracing::warn!(error = %e, "mb_cache write failed");
            }
        }
        Ok(value)
    }

    async fn fetch(
        &self,
        priority: Priority,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value> {
        let mut url = self
            .cfg
            .base
            .join(path)
            .map_err(|e| MbError::Transport(format!("bad url: {e}")))?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("fmt", "json");
            for (k, v) in query {
                pairs.append_pair(k, v);
            }
        }

        let mut attempt = 0;
        loop {
            self.limiter.acquire(priority).await;
            let resp = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|e| MbError::Transport(e.to_string()))?;
            let status = resp.status();
            match status {
                s if s.is_success() => {
                    return resp.json().await.map_err(|e| MbError::Parse(e.to_string()));
                }
                StatusCode::NOT_FOUND => return Err(MbError::NotFound),
                StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS => {
                    if attempt >= MAX_RETRIES {
                        return Err(MbError::RateLimited);
                    }
                    attempt += 1;
                    let wait = retry_after(&resp).unwrap_or(self.cfg.retry_delay);
                    tracing::warn!(%status, ?wait, attempt, "MusicBrainz throttled, retrying");
                    tokio::time::sleep(wait).await;
                }
                other => {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(MbError::Http {
                        status: other.as_u16(),
                        body: body.chars().take(300).collect(),
                    });
                }
            }
        }
    }
}

fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let secs: u64 = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs.min(30)))
}

fn limit_str(limit: u8) -> String {
    limit.clamp(1, 100).to_string()
}

/// Ключ кэша: `path?k=v&...` с отсортированными параметрами.
fn cache_key(path: &str, query: &[(&str, &str)]) -> String {
    let mut q: Vec<_> = query.to_vec();
    q.sort();
    let joined: Vec<String> = q.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{path}?{}", joined.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_order_independent() {
        assert_eq!(
            cache_key("artist", &[("query", "x"), ("limit", "5")]),
            cache_key("artist", &[("limit", "5"), ("query", "x")])
        );
        assert_eq!(cache_key("artist/1", &[]), "artist/1?");
    }
}
