//! Задачи `DiscoverAlbum` и `DiscoverArtist`: поиск раздач у провайдеров, ранжирование,
//! сохранение в `torrents`/`album_torrents` и постановка `VerifyTorrent`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use nimbus_core::events::{Event, JobStage};
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND};
use nimbus_core::model::{
    Album, Artist, InfoHash, MetaStatus, NewTorrent, NotFoundReason, Torrent, TorrentKind,
    TrackStatus,
};
use nimbus_db::repo::jobs::EnqueueOpts;
use nimbus_db::repo::{acquisition, album_torrents, albums, artists, jobs, torrents, tracks};
use nimbus_torrent::parse_torrent_file;
use nimbus_trackers::rank::{classify, score, FormatPrefs, RankInput};
use nimbus_trackers::{
    build_magnet, build_queries, ProviderError, SearchQuery, TorrentCandidate, PUBLIC_TRACKERS,
};

use crate::runner::{JobCtx, JobError, JobHandler};
use crate::verify::{finalize_album, finalize_album_from_discover};

/// Паузы между попытками поиска, когда провайдеры отвечали ошибками и кандидатов нет (по номеру попытки).
pub const RETRY_DELAYS: [Duration; 4] = [
    Duration::from_secs(30),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(10 * 60),
];
/// Запас сверх времени до закрытия предохранителя, прежде чем повторить поиск.
const CIRCUIT_SLACK: Duration = Duration::from_secs(5);
/// Границы ожидания, пока предохранитель провайдера разомкнут.
const DEFER_MIN: Duration = Duration::from_secs(10);
const DEFER_MAX: Duration = Duration::from_secs(15 * 60);
/// Минимальный балл дискографии (без учёта альбома).
pub const DISCOGRAPHY_MIN_SCORE: f32 = 0.2;
/// Небольшой бонус к баллу дискографии при привязке к альбомам.
pub const DISCOGRAPHY_LINK_BONUS: f32 = 0.05;
/// Сколько лучших раздач отдаём на проверку первыми: их `VerifyTorrent` идёт с приоритетом
/// на единицу выше (порядок проверки задаёт приоритет очереди, а не искусственные паузы).
pub const EARLY_WAVE: usize = 3;
/// Сколько вариантов запроса используем для альбома (запросы 1–3 из `build_queries`).
const ALBUM_QUERY_COUNT: usize = 3;

pub struct DiscoverHandler;

#[async_trait]
impl JobHandler for DiscoverHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::DISCOVER_ALBUM, Job::DISCOVER_ARTIST]
    }

    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        match job {
            Job::DiscoverAlbum { album_id } => discover_album(ctx, album_id).await,
            Job::DiscoverArtist { artist_id } => discover_artist(ctx, artist_id).await,
            _ => Err(JobError::Fatal("unexpected job kind".into())),
        }
    }

    /// Поиск окончательно не удался. Альбом: если нет ни одной раздачи — его треки
    /// `adding → not_found` (`search_failed`), иначе он финализируется по найденному.
    /// Артист: его альбомы финализируются (их финализация ждала окончания этой задачи).
    async fn on_exhausted(&self, job: &Job, ctx: &JobCtx, _reason: &str) -> Result<(), JobError> {
        let album_id = match job {
            Job::DiscoverAlbum { album_id } => album_id,
            Job::DiscoverArtist { artist_id } => {
                return finalize_artist_albums(ctx, *artist_id, None).await;
            }
            _ => return Ok(()),
        };
        if album_torrents::list_for_album(&ctx.db, *album_id)
            .await?
            .is_empty()
        {
            mark_not_found(ctx, *album_id, NotFoundReason::SearchFailed).await
        } else {
            finalize_album(ctx, *album_id).await
        }
    }
}

/// Финализирует все альбомы артиста из библиотеки (`own_key` — `dedup_key` вызывающей задачи).
async fn finalize_artist_albums(
    ctx: &JobCtx,
    artist_id: i64,
    own_key: Option<&str>,
) -> Result<(), JobError> {
    for a in albums::list_by_artist(&ctx.db, artist_id)
        .await?
        .into_iter()
        .filter(|a| a.in_library)
    {
        match own_key {
            Some(key) => finalize_album_from_discover(ctx, a.id, key).await?,
            None => finalize_album(ctx, a.id).await?,
        }
    }
    Ok(())
}

struct Scored {
    cand: TorrentCandidate,
    score: f32,
    query: String,
}

struct SearchOutcome {
    ranked: Vec<Scored>,
    /// Отказы провайдеров (источник, текст ошибки); одинаковые пары не повторяются.
    provider_errors: Vec<(String, String)>,
}

impl SearchOutcome {
    /// `[{source, error}]` для `album_search_state.provider_errors`.
    fn provider_errors_json(&self) -> serde_json::Value {
        self.provider_errors
            .iter()
            .map(|(source, error)| serde_json::json!({ "source": source, "error": error }))
            .collect()
    }
}

fn dedup_key(c: &TorrentCandidate) -> String {
    match (&c.info_hash, &c.source_topic_id) {
        (Some(h), _) => format!("h:{h}"),
        (None, Some(t)) => format!("t:{}:{t}", c.source.as_str()),
        (None, None) => format!("n:{}:{}", c.source.as_str(), c.title),
    }
}

/// Поиск ничего не нашёл, но часть провайдеров не ответила: «не найдено» тут не вывод, а отсутствие ответа.
/// Если провайдеры лишь отключены предохранителем — отложить до его закрытия, **не тратя попытку**;
/// если они отвечали ошибками — обычный повтор с растущей паузой (до последней попытки).
/// `None` — повторять нечего (ошибок не было либо попытки кончились).
fn inconclusive(ctx: &JobCtx, outcome: &SearchOutcome, what: &str) -> Option<JobError> {
    if outcome.provider_errors.is_empty() {
        return None;
    }
    let circuit = ProviderError::CircuitOpen.to_string();
    if outcome.provider_errors.iter().all(|(_, e)| *e == circuit) {
        let wait = ctx
            .providers
            .health()
            .iter()
            .filter_map(|h| h.open_until)
            .map(|until| (until - chrono::Utc::now()).to_std().unwrap_or_default())
            .min()
            .unwrap_or(DEFER_MIN)
            .saturating_add(CIRCUIT_SLACK)
            .clamp(DEFER_MIN, DEFER_MAX);
        return Some(JobError::Defer {
            after: wait,
            reason: format!("{what}: providers are paused by the circuit breaker; waiting"),
        });
    }
    if ctx.is_last_attempt() {
        return None;
    }
    let delay = RETRY_DELAYS[(ctx.attempt.max(1) as usize - 1).min(RETRY_DELAYS.len() - 1)];
    Some(JobError::Retry {
        after: delay,
        reason: format!(
            "{what}: no candidates, {} provider error(s); retrying",
            outcome.provider_errors.len()
        ),
    })
}

/// Опрашивает провайдеры по каждому запросу, объединяет, оценивает и сортирует кандидатов.
/// `accept` дополнительно фильтрует кандидатов (например, только дискографии).
async fn search_and_rank(
    ctx: &JobCtx,
    queries: &[SearchQuery],
    input: &RankInput<'_>,
    progress_album: Option<i64>,
    accept: impl Fn(&TorrentCandidate) -> bool,
    min_score: f32,
) -> SearchOutcome {
    let settings = ctx.settings.get();
    let prefs = FormatPrefs::from_keys(&settings.search.format_prefs);
    let total = queries.len() as u32;
    let mut best: HashMap<String, Scored> = HashMap::new();
    let mut provider_errors: Vec<(String, String)> = Vec::new();

    let progress = |done: u32| {
        if let Some(album_id) = progress_album {
            ctx.events.publish(Event::JobProgress {
                album_id,
                stage: JobStage::Searching,
                done,
                total,
            });
        }
    };
    progress(0);
    // Запросы идут параллельно (темп каждого провайдера держит его лимитер);
    // результаты разбираем в порядке запросов, чтобы выдача была детерминированной.
    let mut pending: futures::stream::FuturesUnordered<_> = queries
        .iter()
        .enumerate()
        .map(|(i, q)| async move { (i, ctx.providers.search_all(q).await) })
        .collect();
    let mut results = Vec::with_capacity(queries.len());
    while let Some(r) = pending.next().await {
        results.push(r);
        progress(results.len() as u32);
    }
    results.sort_by_key(|(i, _)| *i);
    for (i, outcomes) in results {
        let q = &queries[i];
        for (source, res) in outcomes {
            match res {
                Ok(found) => {
                    for cand in found {
                        if !accept(&cand) {
                            continue;
                        }
                        let s = score(&cand, input, &prefs);
                        if s < min_score {
                            continue;
                        }
                        let key = dedup_key(&cand);
                        if best.get(&key).is_none_or(|b| b.score < s) {
                            best.insert(
                                key,
                                Scored {
                                    cand,
                                    score: s,
                                    query: q.text.clone(),
                                },
                            );
                        }
                    }
                }
                Err(e) => {
                    let failure = (source.as_str().to_string(), e.to_string());
                    if !provider_errors.contains(&failure) {
                        provider_errors.push(failure);
                    }
                    tracing::warn!(?source, query = %q.text, error = %e, "provider failed");
                }
            }
        }
    }
    let mut ranked: Vec<Scored> = best.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.cand.title.cmp(&b.cand.title))
    });
    ranked.truncate(settings.search.max_candidates as usize);
    SearchOutcome {
        ranked,
        provider_errors,
    }
}

/// `resolve` (если нужен hash). `None` — кандидата использовать нельзя.
async fn resolve_candidate(ctx: &JobCtx, s: &Scored) -> Option<TorrentCandidate> {
    let cand = s.cand.clone();
    if cand.info_hash.is_some() {
        return Some(cand);
    }
    let provider = ctx.providers.get(cand.source)?;
    match provider.resolve(cand).await {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::warn!(title = %s.cand.title, error = %e, "resolve failed, skipping candidate");
            None
        }
    }
}

/// Резолвит кандидатов параллельно, затем сохраняет по порядку ранга.
/// Результат — пары (кандидат, раздача) в исходном порядке.
async fn persist_all<'a>(
    ctx: &JobCtx,
    ranked: &'a [Scored],
    kind_of: impl Fn(&Scored) -> TorrentKind,
) -> Result<Vec<(&'a Scored, Torrent)>, JobError> {
    // Не больше `max_candidates` штук; темп запросов задаёт лимитер провайдера.
    let resolved: Vec<Option<TorrentCandidate>> =
        futures::future::join_all(ranked.iter().map(|s| resolve_candidate(ctx, s))).await;
    let mut out = Vec::new();
    for (s, cand) in ranked.iter().zip(resolved) {
        let Some(cand) = cand else { continue };
        if let Some(t) = store(ctx, cand, kind_of(s)).await? {
            out.push((s, t));
        }
    }
    Ok(out)
}

async fn store(
    ctx: &JobCtx,
    cand: TorrentCandidate,
    kind: TorrentKind,
) -> Result<Option<Torrent>, JobError> {
    let Some(hash) = cand.info_hash.clone() else {
        return Ok(None);
    };
    let magnet = cand
        .magnet
        .clone()
        .unwrap_or_else(|| build_magnet(&hash, &cand.title, PUBLIC_TRACKERS));
    let t = torrents::upsert_by_info_hash(
        &ctx.db,
        &NewTorrent {
            info_hash: hash,
            magnet,
            source: cand.source,
            source_topic_id: cand.source_topic_id.clone(),
            title: cand.title.clone(),
            size_bytes: cand.size_bytes.and_then(|v| i64::try_from(v).ok()),
            seeders: cand.seeders.and_then(|v| i32::try_from(v).ok()),
            leechers: cand.leechers.and_then(|v| i32::try_from(v).ok()),
            kind,
        },
    )
    .await?;
    // Провайдер уже скачал `.torrent`: сохраняем и сразу разбираем список файлов — verify такой
    // раздачи не пойдёт в сеть.
    let mut t = t;
    if let Some(bytes) = cand.torrent_file.as_deref() {
        if remember_torrent_file(ctx, &t, bytes).await? {
            t = torrents::get(&ctx.db, t.id).await?.unwrap_or(t);
        }
    }
    Ok(Some(t))
}

/// Сохраняет `.torrent` кандидата и заполняет файлы раздачи (если они ещё неизвестны).
/// `true` — состояние раздачи в БД изменилось. Битый, чужой или слишком большой файл — не ошибка
/// задачи: раздача просто проверится через сеть.
async fn remember_torrent_file(ctx: &JobCtx, t: &Torrent, bytes: &[u8]) -> Result<bool, JobError> {
    let expected = InfoHash::parse(&t.info_hash).ok();
    let meta = match parse_torrent_file(bytes, expected.as_ref()) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(torrent_id = t.id, error = %e, "candidate torrent file is unusable, ignored");
            return Ok(false);
        }
    };
    let mut changed = false;
    if !t.has_torrent_file {
        changed = torrents::set_torrent_file(&ctx.db, t.id, bytes).await?;
    }
    if t.meta_status != MetaStatus::Ok {
        crate::verify::store_files(ctx, t.id, &meta).await?;
        changed = true;
    }
    Ok(changed)
}

/// Оставшиеся `adding` → `not_found` и завершение поиска альбома (итог и расписание повтора)
/// одной транзакцией под блокировкой строки альбома.
async fn mark_not_found(
    ctx: &JobCtx,
    album_id: i64,
    reason: NotFoundReason,
) -> Result<(), JobError> {
    let mut tx = ctx.db.begin().await?;
    sqlx::query("SELECT id FROM albums WHERE id = $1 FOR UPDATE")
        .bind(album_id)
        .fetch_optional(&mut *tx)
        .await?;
    let changed = tracks::set_status_for_album(
        &mut *tx,
        album_id,
        &[TrackStatus::Adding],
        TrackStatus::NotFound,
        Some(reason),
    )
    .await?;
    let finished = acquisition::finish_search(&mut *tx, album_id, Some(reason)).await?;
    tx.commit().await?;
    for t in changed {
        ctx.events.publish(Event::TrackStatus {
            track_id: t.id,
            album_id: t.album_id,
            status: t.status,
            reason: t.status_reason.clone(),
        });
    }
    if finished.is_some() {
        ctx.events.publish_acquisition_changed(album_id);
    }
    Ok(())
}

async fn load_album(ctx: &JobCtx, album_id: i64) -> Result<(Album, Artist), JobError> {
    let album = albums::get(&ctx.db, album_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("album {album_id} not found")))?;
    let artist = artists::get(&ctx.db, album.artist_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("artist {} not found", album.artist_id)))?;
    Ok((album, artist))
}

pub async fn discover_album(ctx: &JobCtx, album_id: i64) -> Result<(), JobError> {
    let (album, artist) = load_album(ctx, album_id).await?;

    // Нечего искать, если нет добавленных в библиотеку треков в статусе `adding`.
    let needs_search = tracks::list_by_album(&ctx.db, album_id)
        .await?
        .iter()
        .any(|t| t.in_library && t.status == TrackStatus::Adding);
    if !needs_search {
        tracing::debug!(album_id, "nothing to discover");
        return Ok(());
    }
    acquisition::mark_search_started(&ctx.db, album_id).await?;

    // Дискографии артиста, найденные `discover_artist` до импорта этого альбома, привязываем сразу.
    // Так не важно, в каком порядке завершились импорт альбома и поиск дискографий.
    let own_key = format!("discover_album:{album_id}");
    let mut queued_verify: HashSet<i64> = HashSet::new();
    if !album_torrents::link_artist_discographies(&ctx.db, album_id)
        .await?
        .is_empty()
    {
        enqueue_verifies(ctx, album_id, &mut queued_verify, ctx.priority).await?;
    }

    let queries: Vec<SearchQuery> = build_queries(&artist.name, &album.title, album.year)
        .into_iter()
        .filter(|q| !q.broad)
        .take(ALBUM_QUERY_COUNT)
        .collect();
    let input = RankInput {
        artist: &artist.name,
        album: &album.title,
        year: album.year,
    };
    let outcome = ctx
        .run(search_and_rank(
            ctx,
            &queries,
            &input,
            Some(album_id),
            |_| true,
            0.0,
        ))
        .await?;

    acquisition::record_search_results(
        &ctx.db,
        album_id,
        i32::try_from(outcome.ranked.len()).unwrap_or(i32::MAX),
        &outcome.provider_errors_json(),
    )
    .await?;

    let kind_of = |s: &Scored| classify(&s.cand.title, &artist.name, &album.title);
    let (first, rest) = outcome
        .ranked
        .split_at(EARLY_WAVE.min(outcome.ranked.len()));

    // Волна 1: лучшие кандидаты уходят на проверку сразу (приоритет выше), не дожидаясь
    // резолва остальных.
    for (s, t) in ctx.run(persist_all(ctx, first, kind_of)).await?? {
        album_torrents::link(&ctx.db, album_id, t.id, &s.query, s.score).await?;
    }
    enqueue_verifies(ctx, album_id, &mut queued_verify, ctx.priority + 1).await?;

    // Волна 2: остальные. Если треки уже найдены волной 1 — это лишь резервные источники.
    for (s, t) in ctx.run(persist_all(ctx, rest, kind_of)).await?? {
        album_torrents::link(&ctx.db, album_id, t.id, &s.query, s.score).await?;
    }
    // Резервные источники (все треки уже найдены) проверяются в фоне.
    let priority = if library_tracks_found(ctx, album_id).await? {
        PRIORITY_BACKGROUND
    } else {
        ctx.priority
    };
    enqueue_verifies(ctx, album_id, &mut queued_verify, priority).await?;

    // Учитываем и раздачи, прилинкованные ранее (например, дискографии из DiscoverArtist).
    let linked = album_torrents::list_for_album(&ctx.db, album_id).await?;
    if linked.is_empty() {
        if let Some(retry) = inconclusive(ctx, &outcome, "discover_album") {
            return Err(retry);
        }
        // Поиск дискографий артиста ещё идёт: он может привязать раздачу к этому альбому.
        // Решение (`not_found`) примет финализация по его завершении.
        if jobs::has_queued_discover(&ctx.db, album_id, Some(&own_key)).await? {
            tracing::debug!(album_id, "no candidates yet, waiting for discover_artist");
            return Ok(());
        }
        mark_not_found(ctx, album_id, NotFoundReason::NoTorrents).await?;
        return Ok(());
    }
    tracing::info!(album_id, torrents = linked.len(), "discovery done");
    // Проверки первой волны могли закончиться, пока мы искали остальных.
    finalize_album_from_discover(ctx, album_id, &own_key).await
}

/// Все ли треки альбома из библиотеки уже найдены/скачаны.
async fn library_tracks_found(ctx: &JobCtx, album_id: i64) -> Result<bool, JobError> {
    Ok(tracks::list_by_album(&ctx.db, album_id)
        .await?
        .iter()
        .filter(|t| t.in_library)
        .all(|t| matches!(t.status, TrackStatus::Found | TrackStatus::Ready)))
}

/// Ставит `VerifyTorrent` для прилинкованных и ещё не проверенных раздач, которых не ставили
/// в этом запуске. Все с одним приоритетом; повторная постановка пары безопасна (`dedup_key`).
async fn enqueue_verifies(
    ctx: &JobCtx,
    album_id: i64,
    queued: &mut HashSet<i64>,
    priority: i16,
) -> Result<(), JobError> {
    let linked = album_torrents::list_for_album(&ctx.db, album_id).await?;
    let fresh: Vec<i64> = linked
        .iter()
        .filter(|t| !t.verified && !queued.contains(&t.torrent.id))
        .map(|t| t.torrent.id)
        .collect();
    for torrent_id in fresh {
        enqueue_verify(ctx, torrent_id, album_id, priority).await?;
        queued.insert(torrent_id);
    }
    Ok(())
}

async fn enqueue_verify(
    ctx: &JobCtx,
    torrent_id: i64,
    album_id: i64,
    priority: i16,
) -> Result<(), JobError> {
    jobs::enqueue(
        &ctx.db,
        &Job::VerifyTorrent {
            torrent_id,
            album_id,
        },
        EnqueueOpts::priority(priority),
    )
    .await?;
    Ok(())
}

/// Поиск дискографий артиста. Идёт параллельно импорту альбомов: найденное запоминается за
/// артистом (`artist_torrents`), привязывается к альбомам, уже лежащим в библиотеке, а к тем,
/// что появятся позже, его привяжет `discover_album`. Альбомные раздачи ищет `discover_album`.
pub async fn discover_artist(ctx: &JobCtx, artist_id: i64) -> Result<(), JobError> {
    let artist = artists::get(&ctx.db, artist_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("artist {artist_id} not found")))?;
    if !artist.in_library {
        return Ok(());
    }
    let own_key = format!("discover_artist:{artist_id}");

    let name = artist.name.trim();
    let queries: Vec<SearchQuery> = [
        format!("{name} discography"),
        format!("{name} дискография"),
        name.to_string(),
    ]
    .into_iter()
    .map(|text| SearchQuery {
        text,
        artist: Some(name.to_string()),
        ..SearchQuery::default()
    })
    .collect();
    let input = RankInput {
        artist: name,
        album: "",
        year: None,
    };
    let outcome = ctx
        .run(search_and_rank(
            ctx,
            &queries,
            &input,
            None,
            |c| classify(&c.title, name, "") == TorrentKind::Discography,
            DISCOGRAPHY_MIN_SCORE,
        ))
        .await?;

    // Ни одной дискографии, а провайдеры не ответили: не делаем вывод «дискографий нет» — повторим позже.
    if outcome.ranked.is_empty() {
        if let Some(retry) = inconclusive(ctx, &outcome, "discover_artist") {
            return Err(retry);
        }
    }
    let stored = ctx
        .run(persist_all(ctx, &outcome.ranked, |_| {
            TorrentKind::Discography
        }))
        .await??;
    for (s, t) in &stored {
        let rank = (s.score + DISCOGRAPHY_LINK_BONUS).min(1.0);
        album_torrents::remember_artist_discography(&ctx.db, artist_id, t.id, &s.query, rank)
            .await?;
    }

    // Привязка к альбомам, уже находящимся в библиотеке, и проверка новых связей.
    // Лучшие раздачи (первая волна) проверяются с приоритетом выше; для альбомов, у которых
    // всё уже найдено, дискография — лишь резерв.
    let rank_of: HashMap<i64, usize> = stored
        .iter()
        .enumerate()
        .map(|(i, (_, t))| (t.id, i))
        .collect();
    let lib_albums: Vec<Album> = albums::list_by_artist(&ctx.db, artist_id)
        .await?
        .into_iter()
        .filter(|a| a.in_library)
        .collect();
    for a in &lib_albums {
        let fresh = album_torrents::link_artist_discographies(&ctx.db, a.id).await?;
        if fresh.is_empty() {
            continue;
        }
        let backup = library_tracks_found(ctx, a.id).await?;
        for torrent_id in fresh {
            let priority = if backup {
                PRIORITY_BACKGROUND
            } else if rank_of.get(&torrent_id).is_some_and(|i| *i < EARLY_WAVE) {
                ctx.priority + 1
            } else {
                ctx.priority
            };
            enqueue_verify(ctx, torrent_id, a.id, priority).await?;
        }
    }
    tracing::info!(
        artist_id,
        discographies = stored.len(),
        albums = lib_albums.len(),
        "artist discovery done"
    );
    // Пока шёл поиск дискографий, финализация альбомов откладывалась — делаем её сейчас.
    finalize_artist_albums(ctx, artist_id, Some(&own_key)).await
}
