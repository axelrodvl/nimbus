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
//!
//! Cloudflare: поиск и вход бывают закрыты managed-челленджем (`cf-mitigated: challenge`). Если задан
//! FlareSolverr ([`crate::flaresolverr`]), страница, упёршаяся в челлендж, берётся из браузера решателя,
//! а его `cf_clearance` и User-Agent — для следующих прямых запросов (как в Jackett).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
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

use crate::flaresolverr::{post_safe, FlareSolverr, Solution, SOLVER_HTTP_TIMEOUT};
use crate::limiter::{Limiter, RUTRACKER_CONCURRENCY, RUTRACKER_INTERVAL};
use crate::magnet::build_magnet;
use crate::types::*;

const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/124.0 Safari/537.36";
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
    /// Свой User-Agent (должен совпадать с браузером, где получен `cf_clearance`).
    pub user_agent: Option<String>,
    /// Дополнительные заголовки, по одному `Name: value` в строке.
    pub headers: Option<String>,
    /// Адрес FlareSolverr (`http://flaresolverr:8191`) для прохождения Cloudflare-челленджа.
    pub flaresolverr_url: Option<String>,
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
    solver: Option<FlareSolverr>,
    /// Решения идут по одному: браузер решателя тяжёлый, а `cf_clearance` от первого подходит всем.
    solve_lock: Mutex<()>,
    /// User-Agent браузера решателя: `cf_clearance` действует только вместе с ним.
    solved_user_agent: RwLock<Option<String>>,
}

/// Кодирует строку в cp1251 и percent-кодирует байты.
pub fn encode_cp1251(text: &str) -> String {
    let (bytes, _, _) = WINDOWS_1251.encode(text);
    percent_encode(&bytes, NON_ALPHANUMERIC).to_string()
}

fn decode_cp1251(bytes: &[u8]) -> String {
    WINDOWS_1251.decode(bytes).0.into_owned()
}

fn is_challenge(resp: &reqwest::Response) -> bool {
    resp.headers()
        .get("cf-mitigated")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"challenge"))
}

/// Как `check_status`, но Cloudflare-челлендж (`cf-mitigated: challenge`, обычно HTTP 403) — это не ошибка
/// учётных данных, а блокировка клиента: объясняем, что делать.
fn check_rutracker(resp: reqwest::Response) -> Result<reqwest::Response, ProviderError> {
    if is_challenge(&resp) {
        return Err(ProviderError::Blocked(format!(
            "RuTracker is behind a Cloudflare challenge (HTTP {}): set a FlareSolverr URL in the RuTracker settings \
             (NIMBUS_FLARESOLVERR_URL), or open rutracker.org in your browser, pass the check, \
             then copy its cf_clearance and bb_session cookies and the browser's User-Agent into the RuTracker settings",
            resp.status().as_u16()
        )));
    }
    check_status(resp)
}

fn solver_rejected(what: &str) -> ProviderError {
    ProviderError::Blocked(format!(
        "RuTracker is behind a Cloudflare challenge and FlareSolverr did not get past it ({what}); \
         make sure FlareSolverr goes out through the same IP/proxy as Nimbus"
    ))
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
            // Строка из браузера содержит несколько cookie (`bb_session=…; cf_clearance=…`): в jar их
            // нужно класть по одной, иначе всё после первой `;` разберётся как атрибуты Set-Cookie.
            for part in cookie.split(';').map(str::trim).filter(|p| p.contains('=')) {
                jar.add_cookie_str(&format!("{part}; Path=/"), &base_url);
            }
        }
        let mut extra = reqwest::header::HeaderMap::new();
        if let Some(text) = opts.headers.as_deref() {
            for (name, value) in nimbus_core::settings::parse_extra_headers(text)
                .map_err(|e| ProviderError::Parse(format!("bad RuTracker headers: {e}")))?
            {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|e| ProviderError::Parse(format!("bad header name: {e}")))?;
                let value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|e| ProviderError::Parse(format!("bad header value: {e}")))?;
                extra.insert(name, value);
            }
        }
        let user_agent = opts
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .unwrap_or(DEFAULT_USER_AGENT)
            .to_string();
        let mut builder = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(user_agent)
            .default_headers(extra)
            .connect_timeout(crate::registry::CONNECT_TIMEOUT)
            .timeout(crate::registry::PROVIDER_TIMEOUT);
        if let Some(proxy) = opts.proxy.as_deref() {
            let proxy = reqwest::Proxy::all(proxy)
                .map_err(|e| ProviderError::Parse(format!("bad NIMBUS_RUTRACKER_PROXY: {e}")))?;
            builder = builder.proxy(proxy);
        }
        let http = builder.build().map_err(ProviderError::from)?;
        let solver = opts
            .flaresolverr_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(|u| FlareSolverr::new(u, opts.proxy.clone()))
            .transpose()?;
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
            solver,
            solve_lock: Mutex::new(()),
            solved_user_agent: RwLock::new(None),
        })
    }

    /// Подставляет User-Agent решателя, если `cf_clearance` получен через него.
    fn with_ua(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let ua = self
            .solved_user_agent
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match ua {
            Some(ua) => rb.header(reqwest::header::USER_AGENT, ua),
            None => rb,
        }
    }

    /// Cookie сайта парами `(имя, значение)` — их получит и браузер решателя.
    fn site_cookies(&self) -> Vec<(String, String)> {
        let Some(header) = self.jar.cookies(&self.base_url) else {
            return Vec::new();
        };
        header
            .to_str()
            .unwrap_or("")
            .split(';')
            .filter_map(|p| p.trim().split_once('='))
            .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
            .collect()
    }

    /// Открывает `url` через FlareSolverr (с формой `form` — POST); его cookie (`cf_clearance`, а после
    /// входа и `bb_session`) и User-Agent — для следующих запросов.
    async fn solve(
        &self,
        solver: &FlareSolverr,
        url: &str,
        form: Option<&str>,
    ) -> Result<Solution, ProviderError> {
        let _guard = self.solve_lock.lock().await;
        tracing::info!(
            url,
            post = form.is_some(),
            "rutracker: Cloudflare challenge, asking FlareSolverr"
        );
        let cookies = self.site_cookies();
        let solution = match form {
            Some(form) => solver.post(url, form, &cookies).await?,
            None => solver.get(url, &cookies).await?,
        };
        for (name, value) in &solution.cookies {
            self.jar
                .add_cookie_str(&format!("{name}={value}; Path=/"), &self.base_url);
        }
        if let Some(ua) = &solution.user_agent {
            *self
                .solved_user_agent
                .write()
                .unwrap_or_else(PoisonError::into_inner) = Some(ua.clone());
        }
        Ok(solution)
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
        let url = self.url(rel);
        let resp = self
            .with_ua(self.http.get(&url))
            .send()
            .await
            .map_err(blocked_hint)?;
        if let (true, Some(solver)) = (is_challenge(&resp), &self.solver) {
            drop(resp);
            let solution = self.solve(solver, &url, None).await?;
            if !solution.passed() {
                return Err(solver_rejected(&format!("HTTP {}", solution.status)));
            }
            let final_url = reqwest::Url::parse(&solution.url)
                .or_else(|_| reqwest::Url::parse(&url))
                .map_err(|e| ProviderError::Parse(e.to_string()))?;
            return Ok((solution.html, final_url));
        }
        let resp = check_rutracker(resp)?;
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
        let post = || {
            self.with_ua(self.http.post(self.url("login.php")))
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body.clone())
                .send()
        };
        let mut resp = post().await.map_err(blocked_hint)?;
        let mut via_solver = None;
        if let (true, Some(solver)) = (is_challenge(&resp), &self.solver) {
            // Сначала `cf_clearance` от решателя и прямой POST (форма в cp1251 как есть).
            drop(resp);
            let login_url = self.url("login.php");
            self.solve(solver, &login_url, None).await?;
            resp = post().await.map_err(blocked_hint)?;
            if is_challenge(&resp) {
                // Cloudflare не пускает и с cf_clearance (отличает наш HTTP-клиент от браузера):
                // отправляем форму из браузера решателя. Он искажает значения с символами вне
                // `[A-Za-z0-9_.-~]`, поэтому для таких логинов/паролей — только cookie.
                if !post_safe(user) || !post_safe(pass) {
                    return Err(ProviderError::Auth(
                        "Cloudflare only lets the FlareSolverr browser in, and it cannot post a username or password \
                         with characters other than A-Z, a-z, 0-9, _ . - ~: log in with a browser and paste \
                         the bb_session cookie into the RuTracker settings"
                            .into(),
                    ));
                }
                let form = format!("login_username={user}&login_password={pass}&login=1");
                let solution = self.solve(solver, &login_url, Some(&form)).await?;
                if !solution.passed() {
                    return Err(solver_rejected(&format!("login, HTTP {}", solution.status)));
                }
                via_solver = Some(solution.html);
            }
        }
        let html = match via_solver {
            Some(html) => html,
            None => {
                let resp = check_rutracker(resp)?;
                let bytes = resp.bytes().await.map_err(blocked_hint)?;
                decode_cp1251(&bytes)
            }
        };
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

    /// С решателем поиск может включать до двух челленджей (страница и вход) по `SOLVER_HTTP_TIMEOUT`.
    fn timeout_hint(&self) -> Option<Duration> {
        self.solver
            .as_ref()
            .map(|_| SOLVER_HTTP_TIMEOUT * 2 + crate::registry::PROVIDER_TIMEOUT * 3)
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
        let body = check_rutracker(resp)?
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
