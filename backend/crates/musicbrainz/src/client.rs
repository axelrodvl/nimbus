use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{self, StreamExt};
use nimbus_core::settings::MusicbrainzSettings;
use nimbus_db::repo::mb_cache;
use nimbus_db::PgPool;
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use uuid::Uuid;

use crate::canonical::pick_canonical;
use crate::error::{MbError, Result};
use crate::limiter::{Limiter, MbLimits};
use crate::lucene::search_query;
use crate::model::*;

pub const SEARCH_TTL: Duration = Duration::from_secs(24 * 3600);
pub const LOOKUP_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

const MAX_RETRIES: u32 = 3;
const PAGE_LIMIT: usize = 100;
/// Размер страницы browse релизов с `inc=recordings`: для «тяжёлых» запросов MusicBrainz
/// ограничивает `limit` (документация — 25). Листаем по фактически полученному числу.
const RELEASE_BROWSE_LIMIT: usize = 25;

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
    /// Темп, burst и параллелизм (по умолчанию — правила публичного сервера: 1 запрос/с).
    pub limits: MbLimits,
    /// Пауза перед повтором при 503/429, если нет `Retry-After`.
    pub retry_delay: Duration,
    pub timeout: Duration,
    /// База ListenBrainz API для сигнала популярности (`None` — без переранжирования).
    pub lb_base: Option<Url>,
}

impl MbConfig {
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            base: Url::parse("https://musicbrainz.org/ws/2/").expect("valid url"),
            user_agent: user_agent.into(),
            limits: MbLimits::public(),
            retry_delay: Duration::from_secs(2),
            timeout: Duration::from_secs(15),
            lb_base: Some(Url::parse("https://api.listenbrainz.org/1/").expect("valid url")),
        }
    }
}

/// Что клиент делает прямо сейчас — для отображения прогресса долгих операций (импорт артиста).
#[derive(Debug, Clone)]
pub enum MbEvent {
    /// Запрос ждёт очередь лимитера (темп, `Retry-After`).
    Waiting { what: String },
    /// Запрос отправлен (`attempt` с нуля).
    Sent { what: String, attempt: u32 },
    /// Ответ получен.
    Received { what: String, millis: u64 },
    /// MusicBrainz ответил 503/429; повтор через `wait` (`attempt` из `max`).
    Throttled {
        status: u16,
        wait: Duration,
        attempt: u32,
        max: u32,
    },
    /// Пачка страниц: загружено `loaded` из `total` (`what` — «release groups», «releases»).
    Pages {
        what: &'static str,
        loaded: usize,
        total: usize,
    },
    /// Добор релизов по одной группе: готово `done` из `total`.
    Fallback { done: usize, total: usize },
}

/// Получатель событий [`MbEvent`]; вызывается синхронно, из любой задачи — должен быть быстрым.
pub type MbObserver = Arc<dyn Fn(MbEvent) + Send + Sync>;

type Flight = Shared<BoxFuture<'static, Result<Arc<Value>>>>;

/// Результат пакетного импорта дискографии.
#[derive(Debug, Clone)]
pub struct BulkGroup {
    pub group: ReleaseGroupHit,
    /// Выбранный каноничный релиз.
    pub release: Uuid,
    pub tracklist: ReleaseTracklist,
}

/// Группы, не получившие пригодного релиза, возвращаются отдельно: вызывающий решает, что с ними делать.
#[derive(Debug, Clone, Default)]
pub struct BulkReleases {
    pub groups: Vec<BulkGroup>,
    /// Группы без пригодного релиза/треклиста в MusicBrainz.
    pub unavailable: Vec<ReleaseGroupHit>,
}

struct Inner {
    http: reqwest::Client,
    cfg: MbConfig,
    /// Текущая база и лимитер: заменяются `reconfigure`; запросы в полёте доживают на прежних.
    base: RwLock<Url>,
    limiter: RwLock<Arc<Limiter>>,
    cache: Option<PgPool>,
    inflight: Mutex<HashMap<String, Flight>>,
}

/// Клиент MusicBrainz. Дёшево клонируется; клоны делят лимитер, кэш и single-flight.
#[derive(Clone)]
pub struct MbClient {
    inner: Arc<Inner>,
    priority: Priority,
    observer: Option<MbObserver>,
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
                base: RwLock::new(cfg.base.clone()),
                limiter: RwLock::new(Arc::new(Limiter::new(cfg.limits))),
                cfg,
                cache,
                inflight: Mutex::new(HashMap::new()),
            }),
            priority: Priority::Interactive,
            observer: None,
        })
    }

    /// Применяет адрес и лимиты из настроек (с учётом профиля зеркала, `effective()`) на лету.
    /// HTTP-клиент и кэш те же; запросы в полёте завершаются на прежних значениях.
    pub fn reconfigure(&self, settings: &MusicbrainzSettings) -> Result<()> {
        let eff = settings.effective();
        let base: Url = eff
            .base_url
            .parse()
            .map_err(|e| MbError::Transport(format!("bad musicbrainz.base_url: {e}")))?;
        *self
            .inner
            .base
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = base;
        *self
            .inner
            .limiter
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Arc::new(Limiter::new(MbLimits::from(&eff)));
        Ok(())
    }

    /// Клон с фоновым приоритетом (для массовых lookup'ов из задач).
    pub fn background(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            priority: Priority::Background,
            observer: self.observer.clone(),
        }
    }

    /// Клон, сообщающий о ходе запросов `observer`-у (кэш, лимитер и single-flight общие).
    pub fn with_observer(&self, observer: MbObserver) -> Self {
        Self {
            inner: self.inner.clone(),
            priority: self.priority,
            observer: Some(observer),
        }
    }

    /// Сколько нового запроса сейчас ждать из-за очереди перед ним (см. лимитер): нижняя оценка
    /// «молчание — это нормально» для долгих операций.
    pub fn expected_queue_wait(&self) -> Duration {
        self.inner.limiter().expected_wait()
    }

    fn emit(&self, event: MbEvent) {
        if let Some(o) = &self.observer {
            o(event);
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

        // Просроченный ответ не отдаём сразу, но запоминаем: при отказе MusicBrainz он лучше ошибки.
        let mut stale = None;
        if let Some(pool) = &self.inner.cache {
            match mb_cache::get_entry(pool, &key).await {
                Ok(Some(e)) if !e.expired => return Ok(e.value),
                Ok(Some(e)) => stale = Some(e.value),
                Ok(None) => {}
                Err(e) => tracing::warn!(error = %e, "mb_cache read failed"),
            }
        }

        // Просроченная запись у интерактивного запроса (поиск, экран артиста/альбома): отдаём сразу, а свежий ответ
        // подтягиваем в фоне — данные MusicBrainz меняются редко, а пользователь не должен ждать. Фоновые запросы
        // (импорт) по-прежнему ждут свежий ответ.
        if self.priority == Priority::Interactive {
            if let Some(v) = stale.take() {
                drop(self.flight(&key, path, query, ttl, Priority::Background));
                return Ok(v);
            }
        }
        let flight = self.flight(&key, path, query, ttl, self.priority);
        match flight.await {
            Ok(v) => Ok((*v).clone()),
            Err(e) if is_transient(&e) => match stale {
                Some(v) => {
                    tracing::warn!(%path, error = %e, "MusicBrainz unavailable, serving stale cache entry");
                    Ok(v)
                }
                None => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    /// Запрос в полёте по ключу: общий для всех, кто ждёт тот же ответ (single-flight). Сам запрос — отдельная задача,
    /// поэтому он доводится до конца (и пишет в кэш), даже если ожидающих не осталось.
    fn flight(
        &self,
        key: &str,
        path: &str,
        query: &[(&str, &str)],
        ttl: Duration,
        priority: Priority,
    ) -> Flight {
        let mut map = self
            .inner
            .inflight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(f) = map.get(key) {
            return f.clone();
        }
        let inner = self.inner.clone();
        let observer = self.observer.clone();
        let owned_query: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let (path, k) = (path.to_string(), key.to_string());
        // Запрос выполняется отдельной задачей, а не «общим будущим», которое двигают
        // только ожидающие: если все ожидающие ушли (пользователь закрыл страницу),
        // будущее зависло бы в карте вместе с флагом «интерактивный ждёт» в лимитере и
        // навсегда заморозило фоновые запросы. Задача ограничена таймаутом HTTP, поэтому
        // отслеживать её отдельно не нужно; запись из карты убирает она сама.
        let task = tokio::spawn(async move {
            let r = inner
                .fetch_and_cache(priority, observer.as_ref(), &path, &owned_query, ttl, &k)
                .await;
            inner
                .inflight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&k);
            r.map(Arc::new)
        });
        let fut = async move {
            task.await
                .unwrap_or_else(|e| Err(MbError::Transport(format!("request task failed: {e}"))))
        }
        .boxed()
        .shared();
        map.insert(key.to_string(), fut.clone());
        fut
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

    /// Число прослушиваний (ListenBrainz) для записей. MB не ранжирует по популярности:
    /// у «Nothing Else Matters» сотни записей со score 100, и оригинал тонет среди каверов.
    /// Любая ошибка → пустая карта (поиск просто остаётся в порядке MB).
    pub async fn recording_popularity(&self, mbids: &[Uuid]) -> HashMap<Uuid, u64> {
        self.popularity(
            "popularity/recording",
            "recording_mbids",
            "recording_mbid",
            mbids,
        )
        .await
    }

    pub async fn release_group_popularity(&self, mbids: &[Uuid]) -> HashMap<Uuid, u64> {
        self.popularity(
            "popularity/release-group",
            "release_group_mbids",
            "release_group_mbid",
            mbids,
        )
        .await
    }

    /// Популярность с кэшем по каждому MBID (`lb:{path}:{mbid}`, неделя): повторный поиск не ходит в ListenBrainz,
    /// а пересекающиеся запросы спрашивают только то, чего ещё нет. Записи без прослушиваний кэшируются нулём.
    async fn popularity(
        &self,
        path: &str,
        req_field: &str,
        id_field: &str,
        mbids: &[Uuid],
    ) -> HashMap<Uuid, u64> {
        if self.inner.cfg.lb_base.is_none() || mbids.is_empty() {
            return HashMap::new();
        }
        let key = |id: &Uuid| format!("lb:{path}:{id}");
        let mut out = HashMap::new();
        if let Some(pool) = &self.inner.cache {
            let keys: Vec<String> = mbids.iter().map(key).collect();
            match mb_cache::get_many(pool, &keys).await {
                Ok(found) => {
                    for id in mbids {
                        if let Some(n) = found.get(&key(id)).and_then(Value::as_u64) {
                            out.insert(*id, n);
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "mb_cache read failed"),
            }
        }
        let missing: Vec<Uuid> = mbids
            .iter()
            .filter(|id| !out.contains_key(id))
            .copied()
            .collect();
        if missing.is_empty() {
            return out;
        }
        let Some(fetched) = self
            .popularity_fetch(path, req_field, id_field, &missing)
            .await
        else {
            return out;
        };
        if let Some(pool) = &self.inner.cache {
            let rows: Vec<(String, Value)> = missing
                .iter()
                .map(|id| (key(id), Value::from(fetched.get(id).copied().unwrap_or(0))))
                .collect();
            if let Err(e) = mb_cache::put_many(pool, &rows, LOOKUP_TTL).await {
                tracing::warn!(error = %e, "mb_cache write failed");
            }
        }
        out.extend(fetched);
        out
    }

    /// Запрос в ListenBrainz; `None` — ошибка (её не кэшируем).
    async fn popularity_fetch(
        &self,
        path: &str,
        req_field: &str,
        id_field: &str,
        mbids: &[Uuid],
    ) -> Option<HashMap<Uuid, u64>> {
        let base = self.inner.cfg.lb_base.as_ref()?;
        let res: std::result::Result<Vec<Value>, String> = async {
            let url = base.join(path).map_err(|e| e.to_string())?;
            let resp = self
                .inner
                .http
                .post(url)
                .timeout(Duration::from_secs(5))
                .json(&serde_json::json!({ req_field: mbids }))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?;
            resp.json().await.map_err(|e| e.to_string())
        }
        .await;
        match res {
            Ok(items) => Some(
                items
                    .iter()
                    .filter_map(|it| {
                        let id = it.get(id_field)?.as_str()?.parse().ok()?;
                        Some((id, it.get("total_listen_count")?.as_u64()?))
                    })
                    .collect(),
            ),
            Err(e) => {
                tracing::warn!(error = %e, "listenbrainz popularity failed");
                None
            }
        }
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
            self.emit(MbEvent::Pages {
                what: "release groups",
                loaded: (offset + got).min(page.count),
                total: page.count,
            });
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

    /// Каноничный релиз группы вместе с треклистом — одним запросом (вместо двух).
    /// Быстрый путь работает, только если все официальные релизы группы вернулись одной страницей
    /// (тогда выбор тот же, что у `pick_canonical_release`); иначе, как и при любой ошибке
    /// формата ответа, — прежняя пара запросов.
    pub async fn canonical_release_with_tracklist(
        &self,
        release_group: Uuid,
    ) -> Result<(Uuid, ReleaseTracklist)> {
        let rg = release_group.to_string();
        let limit = PAGE_LIMIT.to_string();
        let query = [
            ("release-group", rg.as_str()),
            ("inc", "media recordings artist-credits"),
            ("status", "official"),
            ("limit", limit.as_str()),
        ];
        match self
            .get_typed::<BrowseReleases>("release", &query, LOOKUP_TTL)
            .await
        {
            Ok(page) if !page.releases.is_empty() && page.count <= page.releases.len() => {
                if let Some(found) = complete_canonical(page.releases) {
                    return Ok(found);
                }
            }
            Ok(_) => {}
            // Сеть/лимиты — не повод тратить ещё два запроса: пусть решает вызывающий (повтор задачи).
            Err(e) if is_transient(&e) => return Err(e),
            Err(_) => {}
        }
        let release = self.pick_canonical_release(release_group).await?;
        let tracklist = self.release_tracklist(release).await?;
        Ok((release, tracklist))
    }

    /// Все официальные релизы артиста указанных типов вместе с треклистами, сгруппированные по
    /// release group (см. `artist_releases_bulk_filtered`).
    pub async fn artist_releases_bulk(&self, artist: Uuid, types: &[&str]) -> Result<BulkReleases> {
        self.artist_releases_bulk_filtered(artist, types, |_| true)
            .await
    }

    /// Дискография артиста пачками: список групп + страницы browse релизов сразу с треклистами
    /// (по ~25 релизов на запрос вместо запроса на каждую группу). Каноничный релиз выбирается той же
    /// `pick_canonical`, что и у `canonical_release_with_tracklist`. Группы, для которых полный
    /// треклист не пришёл (нет официальных релизов, неполный носитель, формат ответа не тот),
    /// добираются по одной, параллельно (`max_concurrent`). `keep` отсеивает группы до добора —
    /// лишних запросов для них не будет.
    pub async fn artist_releases_bulk_filtered(
        &self,
        artist: Uuid,
        types: &[&str],
        keep: impl Fn(&ReleaseGroupHit) -> bool,
    ) -> Result<BulkReleases> {
        let groups: Vec<ReleaseGroupHit> = self
            .artist_release_groups(artist, types)
            .await?
            .into_iter()
            .filter(|g| keep(g))
            .collect();
        if groups.is_empty() {
            return Ok(BulkReleases::default());
        }
        let mut by_group = match self
            .browse_artist_releases(artist, types, groups.len())
            .await
        {
            Ok(m) => m,
            // Сеть/лимиты — не повод тратить ещё запросы: пусть решает вызывающий (повтор задачи).
            Err(e) if is_transient(&e) => return Err(e),
            Err(e) => {
                tracing::warn!(error = %e, "bulk release browse unusable, falling back to per-group requests");
                HashMap::new()
            }
        };

        let mut ready: Vec<Option<BulkGroup>> = Vec::with_capacity(groups.len());
        let mut missing: Vec<(usize, ReleaseGroupHit)> = Vec::new();
        for (i, group) in groups.into_iter().enumerate() {
            match by_group.remove(&group.mbid).and_then(complete_canonical) {
                Some((release, tracklist)) => ready.push(Some(BulkGroup {
                    group,
                    release,
                    tracklist,
                })),
                None => {
                    ready.push(None);
                    missing.push((i, group));
                }
            }
        }

        let concurrency = self.inner.limiter().max_concurrent();
        let total = missing.len();
        if total > 0 {
            self.emit(MbEvent::Fallback { done: 0, total });
        }
        let mut pending = stream::iter(missing)
            .map(|(i, group)| async move {
                let r = self.canonical_release_with_tracklist(group.mbid).await;
                (i, group, r)
            })
            .buffer_unordered(concurrency);
        let mut fetched = Vec::with_capacity(total);
        while let Some(item) = pending.next().await {
            fetched.push(item);
            self.emit(MbEvent::Fallback {
                done: fetched.len(),
                total,
            });
        }
        let mut unavailable = Vec::new();
        let mut fetched_ok = Vec::new();
        for (i, group, r) in fetched {
            match r {
                Ok((release, tracklist)) => fetched_ok.push((
                    i,
                    BulkGroup {
                        group,
                        release,
                        tracklist,
                    },
                )),
                Err(MbError::NotFound) => unavailable.push((i, group)),
                Err(e) => return Err(e),
            }
        }
        for (i, b) in fetched_ok {
            ready[i] = Some(b);
        }
        unavailable.sort_by_key(|(i, _)| *i);
        Ok(BulkReleases {
            groups: ready.into_iter().flatten().collect(),
            unavailable: unavailable.into_iter().map(|(_, g)| g).collect(),
        })
    }

    /// Официальные релизы артиста с треклистами, сгруппированные по release group.
    /// Листает по фактически полученному числу, дедуплицирует по `id`. Если релизов столько, что
    /// страниц больше, чем групп (по запросу на группу выйдет дешевле), — пустая карта.
    async fn browse_artist_releases(
        &self,
        artist: Uuid,
        types: &[&str],
        group_count: usize,
    ) -> Result<HashMap<Uuid, Vec<RawRelease>>> {
        let artist_s = artist.to_string();
        let types_s = types.join("|");
        let limit = RELEASE_BROWSE_LIMIT.to_string();
        let mut out: HashMap<Uuid, Vec<RawRelease>> = HashMap::new();
        let mut seen = HashSet::new();
        let mut offset = 0usize;
        loop {
            let off = offset.to_string();
            let mut query = vec![
                ("artist", artist_s.as_str()),
                ("status", "official"),
                ("inc", "release-groups media recordings artist-credits"),
                ("limit", limit.as_str()),
                ("offset", off.as_str()),
            ];
            if !types_s.is_empty() {
                query.push(("type", types_s.as_str()));
            }
            let page: BrowseReleases = self.get_typed("release", &query, LOOKUP_TTL).await?;
            if offset == 0 && page.count > group_count.saturating_mul(RELEASE_BROWSE_LIMIT) {
                return Ok(HashMap::new());
            }
            let got = page.releases.len();
            self.emit(MbEvent::Pages {
                what: "releases",
                loaded: (offset + got).min(page.count),
                total: page.count,
            });
            for r in page.releases {
                if !seen.insert(r.id) {
                    continue;
                }
                let Some(group) = r.release_group.as_ref().map(|g| g.id) else {
                    return Err(MbError::Parse(format!(
                        "release {} has no release-group (inc=release-groups unsupported?)",
                        r.id
                    )));
                };
                out.entry(group).or_default().push(r);
            }
            offset += got;
            if got == 0 || offset >= page.count {
                break;
            }
        }
        Ok(out)
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
        observer: Option<&MbObserver>,
        path: &str,
        query: &[(String, String)],
        ttl: Duration,
        key: &str,
    ) -> Result<Value> {
        let value = match self.fetch(priority, observer, path, query).await {
            Ok(v) => v,
            // Сущность пропала из MusicBrainz: прежний ответ в кэше остаётся (кэш никогда не чистится сам).
            Err(e) => return Err(e),
        };
        if let Some(pool) = &self.cache {
            if let Err(e) = mb_cache::put(pool, key, &value, ttl).await {
                tracing::warn!(error = %e, "mb_cache write failed");
            }
        }
        Ok(value)
    }

    fn limiter(&self) -> Arc<Limiter> {
        self.limiter
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    async fn fetch(
        &self,
        priority: Priority,
        observer: Option<&MbObserver>,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value> {
        let emit = |e: MbEvent| {
            if let Some(o) = observer {
                o(e);
            }
        };
        let base = self
            .base
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut url = base
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
            // Лимитер берём заново на каждой попытке: `reconfigure` действует и на повторы.
            let limiter = self.limiter();
            emit(MbEvent::Waiting {
                what: path.to_string(),
            });
            let permit = limiter.acquire(priority).await;
            emit(MbEvent::Sent {
                what: path.to_string(),
                attempt,
            });
            let sent = std::time::Instant::now();
            let resp = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|e| MbError::Transport(e.to_string()))?;
            let status = resp.status();
            emit(MbEvent::Received {
                what: path.to_string(),
                millis: u64::try_from(sent.elapsed().as_millis()).unwrap_or(u64::MAX),
            });
            match status {
                s if s.is_success() => {
                    let body = resp.json().await.map_err(|e| MbError::Parse(e.to_string()));
                    drop(permit);
                    limiter.on_success();
                    return body;
                }
                StatusCode::NOT_FOUND => return Err(MbError::NotFound),
                StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS => {
                    drop(permit);
                    // `Retry-After: 0` (или его отсутствие) не повод долбить сервер сразу: пауза растёт 1×, 2×, 4×…
                    let wait = retry_after(&resp)
                        .filter(|d| !d.is_zero())
                        .unwrap_or_else(|| self.cfg.retry_delay * 2u32.pow(attempt.min(8)));
                    // Темп снижается, пауза действует на всех (в том числе на параллельные запросы).
                    limiter.on_throttled(Some(wait));
                    if attempt >= MAX_RETRIES {
                        return Err(MbError::RateLimited);
                    }
                    attempt += 1;
                    emit(MbEvent::Throttled {
                        status: status.as_u16(),
                        wait,
                        attempt,
                        max: MAX_RETRIES,
                    });
                    tracing::warn!(%status, ?wait, attempt, "MusicBrainz throttled, retrying");
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

/// Лучший релиз группы с полным треклистом (тот же выбор, что у `canonical_release_with_tracklist`).
fn complete_canonical(releases: Vec<RawRelease>) -> Option<(Uuid, ReleaseTracklist)> {
    let briefs: Vec<_> = releases.iter().map(RawRelease::brief).collect();
    let best = pick_canonical(&briefs)?.mbid;
    let r = releases.into_iter().find(|r| r.id == best)?;
    if !r.has_complete_tracklist() {
        return None;
    }
    let full = RawReleaseFull {
        id: r.id,
        media: r.media,
    };
    Some((best, full.into()))
}

/// Отказ сервиса/сети, а не «такого нет» или «ответ не тот»: повод отдать запасной ответ из кэша.
fn is_transient(e: &MbError) -> bool {
    matches!(e, MbError::RateLimited | MbError::Transport(_))
        || matches!(e, MbError::Http { status, .. } if *status >= 500)
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
