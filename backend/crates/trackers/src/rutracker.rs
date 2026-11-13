//! RuTracker: вход по логину/cookie, поиск по HTML (`tracker.php`), info-hash через API/viewtopic.
//!
//! Официального API поиска нет, поэтому разбор HTML держится на селекторах из модуля [`sel`].
//! Структура страницы поиска (кратко):
//!
//! ```html
//! <a id="logged-in-username" href="profile.php?...">user</a>
//! <table id="tor-tbl"><tbody>
//!   <tr class="hl-tr" data-topic_id="123">
//!     <td class="row1 f-name-col"><div class="f-name"><a class="gen f" href="tracker.php?f=1">Rock</a></div></td>
//!     <td class="row4 t-title-col"><div class="t-title"><a class="tLink" data-topic_id="123" href="viewtopic.php?t=123">Название</a></div></td>
//!     <td class="row4 small nowrap tor-size" data-ts_text="512345678">…</td>
//!     <td class="row4 nowrap"><b class="seedmed">57</b></td>
//!     <td class="row4 leechmed bold">3</td>
//!   </tr>
//! </tbody></table>
//! ```
//!
//! Страницы приходят в cp1251; запросы и форма логина кодируются в cp1251 вручную.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use encoding_rs::WINDOWS_1251;
use nimbus_core::model::{InfoHash, TorrentSource};
use percent_encoding::{percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::cookie::{CookieStore, Jar};
use scraper::{Html, Selector};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::limiter::{Limiter, RUTRACKER_CONCURRENCY, RUTRACKER_INTERVAL};
use crate::magnet::build_magnet;
use crate::types::*;

pub const DEFAULT_BASE_URL: &str = "https://rutracker.org/forum/";
pub const DEFAULT_API_URL: &str = "https://api.rutracker.cc";

/// Ретрекеры RuTracker для magnet, собранного из info-hash, полученного через API.
pub const RUTRACKER_TRACKERS: &[&str] = &[
    "http://bt.t-ru.org/ann?magnet",
    "http://bt2.t-ru.org/ann?magnet",
    "http://bt3.t-ru.org/ann?magnet",
    "http://bt4.t-ru.org/ann?magnet",
];

/// Музыкальные разделы форума.
pub const MUSIC_CATEGORY_RE: &str = r"(?i)(музык|music|rock|metal|jazz|blues|pop|rap|hip-hop|electronic|classical|классическ|lossless|flac|mp3|ape|дискограф|discograph|саундтрек|soundtrack|альтернатив|alternative|indie|folk|punk|шансон|эстрад)";

/// Все CSS-селекторы в одном месте — на случай, если вёрстка изменится.
mod sel {
    pub const ROWS: &str = "#tor-tbl tbody tr.hl-tr, #tor-tbl tbody tr[data-topic_id]";
    pub const TITLE: &str = "a.tLink, a[data-topic_id]";
    pub const CATEGORY: &str = "a.f, td.f-name a";
    pub const SIZE: &str = "td.tor-size";
    pub const SEEDERS: &str = ".seedmed";
    pub const LEECHERS: &str = ".leechmed";
    pub const LOGGED_IN: &str = "#logged-in-username";
    pub const MAGNET: &str = "a.magnet-link";
}

fn s(css: &str) -> Selector {
    Selector::parse(css).expect("valid selector")
}

fn music_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(MUSIC_CATEGORY_RE).expect("valid regex"))
}

#[derive(Debug, Clone, Default)]
pub struct RutrackerOptions {
    pub base_url: Option<String>,
    pub api_url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// Значение cookie, например `bb_session=…`.
    pub cookie: Option<String>,
    pub proxy: Option<String>,
    pub min_interval: Option<Duration>,
}

pub struct RutrackerProvider {
    http: reqwest::Client,
    jar: Arc<Jar>,
    base_url: reqwest::Url,
    api_url: String,
    username: Option<String>,
    password: Option<String>,
    has_cookie_only: bool,
    limiter: Limiter,
    /// Сериализует вход, чтобы параллельные поиски не логинились по нескольку раз.
    login_lock: Mutex<()>,
    /// Растёт после каждого успешного входа: параллельный запрос, увидевший разлогин, не логинится
    /// повторно, если за время ожидания блокировки вход уже выполнил другой.
    login_gen: AtomicU64,
}

/// Кодирует строку в cp1251 и percent-кодирует байты.
pub fn encode_cp1251(text: &str) -> String {
    let (bytes, _, _) = WINDOWS_1251.encode(text);
    percent_encode(&bytes, NON_ALPHANUMERIC).to_string()
}

fn decode_cp1251(bytes: &[u8]) -> String {
    WINDOWS_1251.decode(bytes).0.into_owned()
}

fn blocked_hint(e: reqwest::Error) -> ProviderError {
    if e.is_connect() || e.is_timeout() {
        ProviderError::Blocked(format!(
            "RuTracker unreachable ({}); it may be blocked in your region — set NIMBUS_RUTRACKER_PROXY",
            e.without_url()
        ))
    } else {
        ProviderError::from(e)
    }
}

impl RutrackerProvider {
    pub fn new(opts: RutrackerOptions) -> Result<Self, ProviderError> {
        let base = opts.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL);
        let mut base = base.to_string();
        if !base.ends_with('/') {
            base.push('/');
        }
        let base_url = reqwest::Url::parse(&base)
            .map_err(|e| ProviderError::Parse(format!("bad RuTracker URL: {e}")))?;

        let jar = Arc::new(Jar::default());
        if let Some(cookie) = opts.cookie.as_deref() {
            let cookie = cookie.trim();
            let cookie = if cookie.contains('=') {
                cookie.to_string()
            } else {
                format!("bb_session={cookie}")
            };
            jar.add_cookie_str(&format!("{cookie}; Path=/"), &base_url);
        }
        let mut builder = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/124.0 Safari/537.36",
            )
            .connect_timeout(crate::registry::CONNECT_TIMEOUT)
            .timeout(crate::registry::PROVIDER_TIMEOUT);
        if let Some(proxy) = opts.proxy.as_deref() {
            let proxy = reqwest::Proxy::all(proxy)
                .map_err(|e| ProviderError::Parse(format!("bad NIMBUS_RUTRACKER_PROXY: {e}")))?;
            builder = builder.proxy(proxy);
        }
        let http = builder.build().map_err(ProviderError::from)?;
        Ok(Self {
            http,
            jar,
            base_url,
            api_url: opts
                .api_url
                .unwrap_or_else(|| DEFAULT_API_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            has_cookie_only: opts.cookie.is_some() && opts.username.is_none(),
            username: opts.username,
            password: opts.password,
            limiter: Limiter::new(
                opts.min_interval.unwrap_or(RUTRACKER_INTERVAL),
                RUTRACKER_CONCURRENCY,
            ),
            login_lock: Mutex::new(()),
            login_gen: AtomicU64::new(0),
        })
    }

    fn url(&self, rel: &str) -> String {
        self.base_url
            .join(rel)
            .map(String::from)
            .unwrap_or_default()
    }

    fn has_session(&self) -> bool {
        self.jar
            .cookies(&self.base_url)
            .and_then(|v| v.to_str().ok().map(|s| s.contains("bb_session=")))
            .unwrap_or(false)
    }

    fn can_login(&self) -> bool {
        self.username.is_some() && self.password.is_some()
    }

    async fn get_html(&self, rel: &str) -> Result<(String, reqwest::Url), ProviderError> {
        let _permit = self.limiter.acquire().await;
        let resp = self
            .http
            .get(self.url(rel))
            .send()
            .await
            .map_err(blocked_hint)?;
        let resp = check_status(resp)?;
        let final_url = resp.url().clone();
        let bytes = resp.bytes().await.map_err(blocked_hint)?;
        Ok((decode_cp1251(&bytes), final_url))
    }

    async fn login(&self) -> Result<(), ProviderError> {
        let (Some(user), Some(pass)) = (&self.username, &self.password) else {
            return Err(ProviderError::Auth(
                "RuTracker session expired: update NIMBUS_RUTRACKER_COOKIE".into(),
            ));
        };
        let _permit = self.limiter.acquire().await;
        let body = format!(
            "login_username={}&login_password={}&login={}",
            encode_cp1251(user),
            encode_cp1251(pass),
            encode_cp1251("вход"),
        );
        let resp = self
            .http
            .post(self.url("login.php"))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(blocked_hint)?;
        let resp = check_status(resp)?;
        let bytes = resp.bytes().await.map_err(blocked_hint)?;
        let html = decode_cp1251(&bytes);
        if html.contains("cap_sid") || html.to_lowercase().contains("captcha") {
            return Err(ProviderError::Auth(
                "captcha required: set NIMBUS_RUTRACKER_COOKIE".into(),
            ));
        }
        if !self.has_session() {
            return Err(ProviderError::Auth(
                "RuTracker login failed: wrong username or password".into(),
            ));
        }
        self.login_gen.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Гарантирует наличие сессии перед запросом.
    async fn ensure_session(&self) -> Result<(), ProviderError> {
        if self.has_session() {
            return Ok(());
        }
        let _guard = self.login_lock.lock().await;
        if self.has_session() {
            return Ok(());
        }
        self.login().await
    }

    /// GET страницы с авторизацией: при признаках разлогина — один повторный вход.
    async fn get_authed(&self, rel: &str) -> Result<String, ProviderError> {
        self.ensure_session().await?;
        for attempt in 0..2 {
            let seen_gen = self.login_gen.load(Ordering::SeqCst);
            let (html, url) = self.get_html(rel).await?;
            if !is_logged_out(&html, &url) {
                return Ok(html);
            }
            if attempt == 1 || self.has_cookie_only || !self.can_login() {
                return Err(ProviderError::Auth(if self.can_login() {
                    "RuTracker rejected the session after re-login".into()
                } else {
                    "RuTracker session expired: update NIMBUS_RUTRACKER_COOKIE".into()
                }));
            }
            let _guard = self.login_lock.lock().await;
            // Пока ждали блокировку, другой запрос уже перелогинился — просто повторяем.
            if self.login_gen.load(Ordering::SeqCst) == seen_gen {
                self.login().await?;
            }
        }
        unreachable!()
    }

    pub fn parse_search(html: &str) -> Vec<TorrentCandidate> {
        let doc = Html::parse_document(html);
        let (rows, title, cat, size, seed, leech) = (
            s(sel::ROWS),
            s(sel::TITLE),
            s(sel::CATEGORY),
            s(sel::SIZE),
            s(sel::SEEDERS),
            s(sel::LEECHERS),
        );
        let topic_re = Regex::new(r"viewtopic\.php\?t=(\d+)").expect("valid regex");
        let text = |e: scraper::ElementRef| {
            e.text()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        let count = |e: Option<scraper::ElementRef>| {
            e.and_then(|e| text(e).parse::<i64>().ok())
                .and_then(|n| u32::try_from(n).ok())
        };

        doc.select(&rows)
            .filter_map(|row| {
                let a = row.select(&title).next()?;
                let topic_id = a
                    .value()
                    .attr("data-topic_id")
                    .map(str::to_string)
                    .or_else(|| {
                        a.value()
                            .attr("href")
                            .and_then(|h| topic_re.captures(h))
                            .map(|c| c[1].to_string())
                    })
                    .or_else(|| row.value().attr("data-topic_id").map(str::to_string))?;
                let category = row.select(&cat).next().map(text).filter(|c| !c.is_empty());
                // Только музыкальные разделы (фильмы, книги, игры отбрасываем).
                if !category.as_deref().is_some_and(|c| music_re().is_match(c)) {
                    return None;
                }
                let size_bytes = row.select(&size).next().and_then(|e| {
                    e.value()
                        .attr("data-ts_text")
                        .and_then(|v| v.trim().parse().ok())
                        .or_else(|| parse_size(&text(e)))
                });
                Some(TorrentCandidate {
                    source: TorrentSource::Rutracker,
                    source_topic_id: Some(topic_id),
                    title: text(a),
                    info_hash: None,
                    magnet: None,
                    download_url: None,
                    size_bytes,
                    seeders: count(row.select(&seed).next()),
                    leechers: count(row.select(&leech).next()),
                    category,
                    files_count: None,
                    torrent_file: None,
                })
            })
            .collect()
    }
}

/// Разбирает текст вида «1.2 GB» / «700 MB» / «1,5 ГБ».
fn parse_size(text: &str) -> Option<u64> {
    let t = text.replace('\u{a0}', " ").replace(',', ".");
    let mut it = t.split_whitespace();
    let num: f64 = it.next()?.parse().ok()?;
    let mult: f64 = match it.next()?.to_lowercase().as_str() {
        "b" | "б" => 1.0,
        "kb" | "кб" => 1024.0,
        "mb" | "мб" => 1024.0 * 1024.0,
        "gb" | "гб" => 1024.0 * 1024.0 * 1024.0,
        "tb" | "тб" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((num * mult) as u64)
}

fn is_logged_out(html: &str, url: &reqwest::Url) -> bool {
    if url.path().ends_with("login.php") {
        return true;
    }
    let doc = Html::parse_document(html);
    doc.select(&s(sel::LOGGED_IN)).next().is_none()
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    result: std::collections::HashMap<String, Option<ApiTopic>>,
}
#[derive(Debug, Deserialize)]
struct ApiTopic {
    info_hash: Option<String>,
    seeders: Option<u32>,
    size: Option<u64>,
}

#[async_trait]
impl TorrentProvider for RutrackerProvider {
    fn source(&self) -> TorrentSource {
        TorrentSource::Rutracker
    }

    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        let rel = format!("tracker.php?nm={}&o=10&s=2", encode_cp1251(&q.text));
        let html = self.get_authed(&rel).await?;
        Ok(Self::parse_search(&html))
    }

    async fn resolve(&self, mut c: TorrentCandidate) -> Result<TorrentCandidate, ProviderError> {
        if c.info_hash.is_some() {
            return Ok(c);
        }
        let Some(topic) = c.source_topic_id.clone() else {
            return Ok(c);
        };

        // Вариант А: публичный API, без авторизации.
        match self.resolve_via_api(&topic).await {
            Ok(Some(t)) => {
                if let Some(hash) = t.info_hash.as_deref().and_then(|h| InfoHash::parse(h).ok()) {
                    c.magnet = Some(build_magnet(&hash, &c.title, RUTRACKER_TRACKERS));
                    c.info_hash = Some(hash);
                    c.seeders = t.seeders.or(c.seeders);
                    c.size_bytes = t.size.or(c.size_bytes);
                    return Ok(c);
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::debug!(error = %e, topic, "rutracker api resolve failed, trying viewtopic")
            }
        }

        // Вариант Б: страница темы, magnet-ссылка (со своим passkey, не трогаем).
        let html = self.get_authed(&format!("viewtopic.php?t={topic}")).await?;
        let doc = Html::parse_document(&html);
        let magnet = doc
            .select(&s(sel::MAGNET))
            .next()
            .and_then(|a| a.value().attr("href"))
            .map(|h| h.replace("&amp;", "&"))
            .ok_or_else(|| ProviderError::Parse("magnet link not found on topic page".into()))?;
        let hash = InfoHash::from_magnet(&magnet)
            .ok_or_else(|| ProviderError::Parse("bad magnet link on topic page".into()))?;
        c.info_hash = Some(hash);
        c.magnet = Some(magnet);
        Ok(c)
    }
}

impl RutrackerProvider {
    async fn resolve_via_api(&self, topic: &str) -> Result<Option<ApiTopic>, ProviderError> {
        let _permit = self.limiter.acquire().await;
        let resp = self
            .http
            .get(format!("{}/v1/get_tor_topic_data", self.api_url))
            .query(&[("by", "topic_id"), ("val", topic)])
            .send()
            .await
            .map_err(blocked_hint)?;
        let body = check_status(resp)?
            .text()
            .await
            .map_err(ProviderError::from)?;
        let parsed: ApiResponse =
            serde_json::from_str(&body).map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(parsed.result.into_iter().find_map(|(_, v)| v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cp1251_encoding() {
        assert_eq!(encode_cp1251("Кино"), "%CA%E8%ED%EE");
        assert_eq!(encode_cp1251("вход"), "%E2%F5%EE%E4");
        assert_eq!(encode_cp1251("a b"), "a%20b");
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("1.5 GB"), Some(1_610_612_736));
        assert_eq!(parse_size("700 MB"), Some(734_003_200));
        assert_eq!(parse_size("1,5 ГБ"), Some(1_610_612_736));
        assert_eq!(parse_size("abc"), None);
    }
}
