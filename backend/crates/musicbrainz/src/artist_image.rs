//! Поиск фото артиста. MusicBrainz фото не хранит, поэтому: url-rels артиста → Wikidata (P18) →
//! Wikimedia Commons; запасной вариант — поиск артиста в Deezer (только точное совпадение имени).
//! Результат (в том числе «не найдено») кэшируется в `mb_cache`, а признак «есть фото» пишется в
//! `artists.image` и едет клиентам синхронизацией (ревью S12).

use std::time::Duration;

use nimbus_db::repo::{artists, mb_cache};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{MbClient, MbError};

/// Сколько живёт найденный адрес.
pub const HIT_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// Сколько живёт ответ «фото нет» (потом артисты сбрасываются в «не искали» и ищутся заново).
pub const MISS_TTL: Duration = Duration::from_secs(24 * 3600);
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

/// Ищет адрес фото артиста: ссылки MusicBrainz → Wikidata/Commons → Deezer. `Ok(None)` — фото нет.
/// `http` — клиент для внешних источников (с таймаутом и User-Agent).
pub async fn find(
    mb: &MbClient,
    http: &reqwest::Client,
    mbid: Uuid,
) -> Result<Option<String>, MbError> {
    let artist = mb
        .get_json(
            &format!("artist/{mbid}"),
            &[("inc", "url-rels")],
            Duration::from_secs(7 * 24 * 3600),
        )
        .await?;
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
        if let Some(u) = wikidata_image(http, &qid).await {
            return Ok(Some(u));
        }
    }
    Ok(deezer_image(http, &name).await)
}

/// HTTP-клиент для внешних источников фото.
pub fn http_client(user_agent: &str) -> Result<reqwest::Client, MbError> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(user_agent)
        .build()
        .map_err(|e| MbError::Transport(e.to_string()))
}

/// Адрес фото артиста с кэшем (`mb_cache` `artist_image:{mbid}`) и записью признака `artists.image`.
/// Результат поиска (в том числе «нет фото») кэшируется на `HIT_TTL` / `MISS_TTL`.
pub async fn resolve(
    db: &PgPool,
    mb: &MbClient,
    user_agent: &str,
    mbid: Uuid,
) -> Result<Option<String>, MbError> {
    resolve_with(db, mbid, || async {
        find(mb, &http_client(user_agent)?, mbid).await
    })
    .await
}

/// [`resolve`] с подставляемым поиском (тесты без сети).
pub async fn resolve_with<F, Fut>(
    db: &PgPool,
    mbid: Uuid,
    finder: F,
) -> Result<Option<String>, MbError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, MbError>>,
{
    let key = format!("artist_image:{mbid}");
    let url = match mb_cache::get(db, &key).await.ok().flatten() {
        Some(v) => v["url"].as_str().map(str::to_string),
        None => {
            let found = finder().await?;
            let ttl = if found.is_some() { HIT_TTL } else { MISS_TTL };
            if let Err(e) = mb_cache::put(db, &key, &json!({ "url": found }), ttl).await {
                tracing::warn!(error = %e, "artist image cache write failed");
            }
            found
        }
    };
    // Признак для клиента: пишется и при попадании в кэш (артисты, найденные до появления колонки).
    if let Err(e) = artists::set_image(db, mbid, Some(url.is_some())).await {
        tracing::warn!(error = %e, %mbid, "artist image flag write failed");
    }
    Ok(url)
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    async fn artist(pool: &PgPool) -> Uuid {
        let mbid = Uuid::new_v4();
        sqlx::query("INSERT INTO artists (mbid, name) VALUES ($1, 'A')")
            .bind(mbid)
            .execute(pool)
            .await
            .unwrap();
        mbid
    }

    async fn flag(pool: &PgPool, mbid: Uuid) -> Option<String> {
        sqlx::query_scalar("SELECT image FROM artists WHERE mbid = $1")
            .bind(mbid)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
    async fn artist_image_sets_flag_yes(pool: PgPool) {
        let mbid = artist(&pool).await;
        let url = resolve_with(&pool, mbid, || async {
            Ok(Some("https://img/x.jpg".to_string()))
        })
        .await
        .unwrap();
        assert_eq!(url.as_deref(), Some("https://img/x.jpg"));
        assert_eq!(flag(&pool, mbid).await.as_deref(), Some("yes"));
    }

    #[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
    async fn artist_image_miss_sets_flag_no(pool: PgPool) {
        let mbid = artist(&pool).await;
        let url = resolve_with(&pool, mbid, || async { Ok(None) })
            .await
            .unwrap();
        assert!(url.is_none());
        assert_eq!(flag(&pool, mbid).await.as_deref(), Some("no"));
    }

    #[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
    async fn artist_image_source_error_leaves_flag_unset(pool: PgPool) {
        let mbid = artist(&pool).await;
        let err = resolve_with(&pool, mbid, || async {
            Err(MbError::Transport("down".into()))
        })
        .await;
        assert!(err.is_err());
        assert_eq!(flag(&pool, mbid).await, None);
    }

    #[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
    async fn artist_image_cache_hit_backfills_flag_without_search(pool: PgPool) {
        let mbid = artist(&pool).await;
        mb_cache::put(
            &pool,
            &format!("artist_image:{mbid}"),
            &json!({ "url": "https://img/y.jpg" }),
            HIT_TTL,
        )
        .await
        .unwrap();
        let url = resolve_with(&pool, mbid, || async {
            Err(MbError::Transport("must not search".into()))
        })
        .await
        .unwrap();
        assert_eq!(url.as_deref(), Some("https://img/y.jpg"));
        assert_eq!(flag(&pool, mbid).await.as_deref(), Some("yes"));
    }
}
