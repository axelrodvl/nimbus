//! FlareSolverr (и совместимые: Byparr): headless-браузер, проходящий Cloudflare-челлендж.
//!
//! API: `POST {url}/v1` с `{"cmd":"request.get","url":…,"maxTimeout":…,"cookies":[…],"proxy":{"url":…}}`;
//! в ответе — HTML страницы, cookie браузера (в том числе `cf_clearance`) и его User-Agent. Как и Jackett,
//! используем ответ решателя для запроса, упёршегося в челлендж, а cookie и User-Agent — для следующих
//! прямых запросов: `cf_clearance` действует, пока совпадают IP и User-Agent.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::types::ProviderError;

/// Сколько решатель может биться над челленджем (`maxTimeout`).
pub const SOLVE_TIMEOUT: Duration = Duration::from_secs(60);
/// Таймаут HTTP-запроса к решателю: `maxTimeout` плюс запас на запуск браузера.
pub const SOLVER_HTTP_TIMEOUT: Duration = Duration::from_secs(75);

pub struct FlareSolverr {
    http: reqwest::Client,
    endpoint: String,
    proxy: Option<String>,
}

/// Результат решателя.
#[derive(Debug, Clone)]
pub struct Solution {
    /// Итоговый адрес (после редиректов).
    pub url: String,
    pub status: u16,
    /// HTML страницы, уже декодированный браузером.
    pub html: String,
    pub cookies: Vec<(String, String)>,
    pub user_agent: Option<String>,
}

impl Solution {
    /// Решатель вернул страницу, а не челлендж.
    pub fn passed(&self) -> bool {
        self.status < 400 && !is_challenge_page(&self.html)
    }
}

/// Признаки страницы Cloudflare «Just a moment…».
pub fn is_challenge_page(html: &str) -> bool {
    html.contains("_cf_chl_opt") || html.contains("challenge-platform")
}

#[derive(Serialize)]
struct Request<'a> {
    cmd: &'static str,
    url: &'a str,
    #[serde(rename = "maxTimeout")]
    max_timeout: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cookies: Vec<CookieOut<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy: Option<ProxyOut<'a>>,
}
#[derive(Serialize)]
struct CookieOut<'a> {
    name: &'a str,
    value: &'a str,
}
#[derive(Serialize)]
struct ProxyOut<'a> {
    url: &'a str,
}

#[derive(Deserialize)]
struct Response {
    status: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    solution: Option<SolutionIn>,
}
#[derive(Deserialize)]
struct SolutionIn {
    #[serde(default)]
    url: String,
    #[serde(default)]
    status: u16,
    #[serde(default)]
    response: Option<String>,
    #[serde(default)]
    cookies: Vec<CookieIn>,
    #[serde(rename = "userAgent", default)]
    user_agent: Option<String>,
}
#[derive(Deserialize)]
struct CookieIn {
    name: String,
    value: String,
}

impl FlareSolverr {
    /// `url` — адрес сервиса (`http://flaresolverr:8191`, можно с `/v1`); `proxy` — тот же прокси, что и у
    /// прямых запросов: `cf_clearance` привязан к IP.
    pub fn new(url: &str, proxy: Option<String>) -> Result<Self, ProviderError> {
        let base = url.trim().trim_end_matches('/');
        let endpoint = if base.ends_with("/v1") {
            base.to_string()
        } else {
            format!("{base}/v1")
        };
        reqwest::Url::parse(&endpoint)
            .map_err(|e| ProviderError::Parse(format!("bad FlareSolverr URL: {e}")))?;
        let http = reqwest::Client::builder()
            .connect_timeout(crate::registry::CONNECT_TIMEOUT)
            .timeout(SOLVER_HTTP_TIMEOUT)
            .build()
            .map_err(ProviderError::from)?;
        Ok(Self {
            http,
            endpoint,
            proxy: proxy.filter(|p| !p.trim().is_empty()),
        })
    }

    /// Открывает `url` в браузере решателя с переданными cookie.
    pub async fn get(
        &self,
        url: &str,
        cookies: &[(String, String)],
    ) -> Result<Solution, ProviderError> {
        let req = Request {
            cmd: "request.get",
            url,
            max_timeout: SOLVE_TIMEOUT.as_millis() as u64,
            cookies: cookies
                .iter()
                .map(|(name, value)| CookieOut { name, value })
                .collect(),
            proxy: self.proxy.as_deref().map(|url| ProxyOut { url }),
        };
        let resp = self
            .http
            .post(&self.endpoint)
            .json(&req)
            .send()
            .await
            .map_err(|e| {
                ProviderError::Blocked(format!(
                    "FlareSolverr is unreachable at {} ({})",
                    self.endpoint,
                    e.without_url()
                ))
            })?;
        let http_status = resp.status();
        let body = resp.text().await.map_err(ProviderError::from)?;
        let parsed: Response = serde_json::from_str(&body).map_err(|e| {
            ProviderError::Parse(format!(
                "unexpected FlareSolverr response (HTTP {}): {e}",
                http_status.as_u16()
            ))
        })?;
        let solution = match (parsed.status.as_str(), parsed.solution) {
            ("ok", Some(s)) => s,
            _ => {
                return Err(ProviderError::Blocked(format!(
                    "FlareSolverr could not pass the Cloudflare challenge: {}",
                    parsed.message
                )))
            }
        };
        Ok(Solution {
            url: solution.url,
            status: solution.status,
            html: solution.response.unwrap_or_default(),
            cookies: solution
                .cookies
                .into_iter()
                .map(|c| (c.name, c.value))
                .collect(),
            user_agent: solution.user_agent.filter(|u| !u.trim().is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_gets_v1_once() {
        let a = FlareSolverr::new("http://fs:8191/", None).unwrap();
        assert_eq!(a.endpoint, "http://fs:8191/v1");
        let b = FlareSolverr::new("http://fs:8191/v1", None).unwrap();
        assert_eq!(b.endpoint, "http://fs:8191/v1");
        assert!(FlareSolverr::new("not a url", None).is_err());
    }

    #[test]
    fn challenge_page_is_not_passed() {
        let s = Solution {
            url: String::new(),
            status: 200,
            html: "<script>window._cf_chl_opt={}</script>".into(),
            cookies: vec![],
            user_agent: None,
        };
        assert!(!s.passed());
        let ok = Solution {
            html: "<html>ok</html>".into(),
            ..s.clone()
        };
        assert!(ok.passed());
        assert!(!Solution { status: 403, ..ok }.passed());
    }
}
