//! `GET /api/artist-image/{mbid}`: редирект на фото артиста.
//! MusicBrainz фото не хранит, поэтому: url-rels артиста → Wikidata (P18) → Wikimedia Commons;
//! запасной вариант — поиск артиста в Deezer (только точное совпадение имени).
//! Результат (в т.ч. «не найдено») кэшируется в `mb_cache`.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use nimbus_db::repo::mb_cache;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

const HIT_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const MISS_TTL: Duration = Duration::from_secs(24 * 3600);
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn commons_url(file: &str) -> Option<String> {
    let mut u = reqwest::Url::parse("https://commons.wikimedia.org/wiki/Special:FilePath/").ok()?;
    u.path_segments_mut().ok()?.pop().push(file);
    u.set_query(Some("width=500"));
    Some(u.into())
}

async fn wikidata_image(http: &reqwest::Client, qid: &str) -> Option<String> {
    let url = format!("https://www.wikidata.org/wiki/Special:EntityData/{qid}.json");
    let v: Value = http.get(url).send().await.ok()?.json().await.ok()?;
    let file = v["entities"][qid]["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"].as_str()?;
    commons_url(file)
}

async fn deezer_image(http: &reqwest::Client, name: &str) -> Option<String> {
    let v: Value = http
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", name), ("limit", "5")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let want = norm(name);
    v["data"].as_array()?.iter().find_map(|a| {
        if norm(a["name"].as_str()?) != want {
            return None;
        }
        let pic = a["picture_big"].as_str()?;
        // Заглушка «нет фото» содержит пустой хеш в пути.
        (!pic.contains("/images/artist//")).then(|| pic.to_string())
    })
}

async fn find_image(state: &AppState, mbid: Uuid) -> Result<Option<String>, ApiError> {
    let http = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(state.config.mb_user_agent.clone())
        .build()
        .map_err(|_| ApiError::internal())?;

    let artist = state
        .mb
        .get_json(
            &format!("artist/{mbid}"),
            &[("inc", "url-rels")],
            Duration::from_secs(7 * 24 * 3600),
        )
        .await
        .map_err(|e| match e {
            nimbus_musicbrainz::MbError::NotFound => {
                ApiError::new(StatusCode::NOT_FOUND, "mb_not_found", "artist not found")
            }
            e => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "mb_unavailable",
                e.to_string(),
            ),
        })?;
    let name = artist["name"].as_str().unwrap_or_default().to_string();

    let mut qid = None;
    for rel in artist["relations"].as_array().into_iter().flatten() {
        let res = rel["url"]["resource"].as_str().unwrap_or_default();
        match rel["type"].as_str() {
            // Прямая ссылка на файл Commons.
            Some("image") if res.contains("commons.wikimedia.org/wiki/File:") => {
                if let Some(f) = res.rsplit("File:").next() {
                    let f = f.replace('_', " ");
                    if let Some(u) = commons_url(&percent_decode(&f)) {
                        return Ok(Some(u));
                    }
                }
            }
            Some("wikidata") => qid = res.rsplit('/').next().map(str::to_string),
            _ => {}
        }
    }
    if let Some(qid) = qid {
        if let Some(u) = wikidata_image(&http, &qid).await {
            return Ok(Some(u));
        }
    }
    Ok(deezer_image(&http, &name).await)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[utoipa::path(
    get,
    path = "/api/artist-image/{mbid}",
    tag = "library",
    params(("mbid" = Uuid, Path, description = "MBID артиста")),
    responses(
        (status = 302, description = "Редирект на изображение"),
        (status = 404, description = "Фото не найдено (`no_image`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn artist_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(mbid): Path<Uuid>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let key = format!("artist_image:{mbid}");
    let cached = mb_cache::get(&state.db, &key).await.ok().flatten();
    let url = match cached {
        Some(v) => v["url"].as_str().map(str::to_string),
        None => {
            let found = find_image(&state, mbid).await?;
            let ttl = if found.is_some() { HIT_TTL } else { MISS_TTL };
            if let Err(e) = mb_cache::put(&state.db, &key, &json!({ "url": found }), ttl).await {
                tracing::warn!(error = %e, "artist image cache write failed");
            }
            found
        }
    };
    match url {
        Some(u) => {
            let mut resp = StatusCode::FOUND.into_response();
            if let Ok(v) = HeaderValue::from_str(&u) {
                resp.headers_mut().insert(header::LOCATION, v);
            }
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            );
            Ok(resp)
        }
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no_image",
            "no artist image",
        )),
    }
}
