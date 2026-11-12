//! Задачи `DiscoverAlbum` и `DiscoverArtist`: поиск раздач у провайдеров, ранжирование,
//! сохранение в `torrents`/`album_torrents` и постановка `VerifyTorrent`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use futures::StreamExt;
use nimbus_core::events::{Event, JobStage};
use nimbus_core::jobs::Job;
use nimbus_core::model::{
    Album, Artist, NewTorrent, NotFoundReason, Torrent, TorrentKind, TrackStatus,
};
use nimbus_db::repo::{album_torrents, albums, artists, jobs, torrents, tracks};
use nimbus_trackers::rank::{classify, score, FormatPrefs, RankInput};
use nimbus_trackers::{
    build_magnet, build_queries, SearchQuery, TorrentCandidate, PUBLIC_TRACKERS,
};

use crate::runner::{JobCtx, JobError, JobHandler};
use crate::verify::{finalize_album_from_discover, LOW_PRIORITY_DELAY};

/// Через сколько повторять поиск, если провайдеры упали и кандидатов нет.
pub const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
/// Минимальный балл дискографии (без учёта альбома).
pub const DISCOGRAPHY_MIN_SCORE: f32 = 0.2;
/// Небольшой бонус к баллу дискографии при привязке к альбомам.
pub const DISCOGRAPHY_LINK_BONUS: f32 = 0.05;
/// Смещение запуска `VerifyTorrent` по рангу раздачи (только чтобы лучшие взялись первыми).
pub const VERIFY_STAGGER: Duration = Duration::from_millis(200);
/// Пауза между постановкой `DiscoverAlbum` для альбомов артиста.
pub const ALBUM_JOB_STAGGER: Duration = Duration::from_secs(5);
/// Сколько лучших раздач отдаём на проверку сразу; остальные резолвятся и ставятся позже.
const EARLY_WAVE: usize = 3;
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
}

struct Scored {
    cand: TorrentCandidate,
    score: f32,
    query: String,
}

struct SearchOutcome {
    ranked: Vec<Scored>,
    provider_errors: usize,
}

fn dedup_key(c: &TorrentCandidate) -> String {
    match (&c.info_hash, &c.source_topic_id) {
        (Some(h), _) => format!("h:{h}"),
        (None, Some(t)) => format!("t:{}:{t}", c.source.as_str()),
        (None, None) => format!("n:{}:{}", c.source.as_str(), c.title),
    }
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
    let mut provider_errors = 0;

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
                    provider_errors += 1;
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
    Ok(Some(t))
}

async fn mark_not_found(ctx: &JobCtx, album_id: i64) -> Result<(), JobError> {
    let changed = tracks::set_status_for_album(
        &ctx.db,
        album_id,
        &[TrackStatus::Adding],
        TrackStatus::NotFound,
        Some(NotFoundReason::NoTorrents),
    )
    .await?;
    for t in changed {
        ctx.events.publish(Event::TrackStatus {
            track_id: t.id,
            album_id: t.album_id,
            status: t.status,
            reason: t.status_reason.clone(),
        });
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
    let outcome = search_and_rank(ctx, &queries, &input, Some(album_id), |_| true, 0.0).await;

    let kind_of = |s: &Scored| classify(&s.cand.title, &artist.name, &album.title);
    let (first, rest) = outcome
        .ranked
        .split_at(EARLY_WAVE.min(outcome.ranked.len()));

    // Волна 1: лучшие кандидаты уходят на проверку сразу, не дожидаясь резолва остальных.
    let mut queued_verify: HashSet<i64> = HashSet::new();
    for (s, t) in persist_all(ctx, first, kind_of).await? {
        album_torrents::link(&ctx.db, album_id, t.id, &s.query, s.score).await?;
    }
    enqueue_verifies(ctx, album_id, &mut queued_verify, Duration::ZERO).await?;

    // Волна 2: остальные. Если треки уже найдены волной 1 — это лишь резервные источники.
    for (s, t) in persist_all(ctx, rest, kind_of).await? {
        album_torrents::link(&ctx.db, album_id, t.id, &s.query, s.score).await?;
    }
    let delay = if library_tracks_found(ctx, album_id).await? {
        LOW_PRIORITY_DELAY
    } else {
        Duration::ZERO
    };
    enqueue_verifies(ctx, album_id, &mut queued_verify, delay).await?;

    // Учитываем и раздачи, прилинкованные ранее (например, дискографии из DiscoverArtist).
    let linked = album_torrents::list_for_album(&ctx.db, album_id).await?;
    if linked.is_empty() {
        if outcome.provider_errors > 0 && !ctx.is_last_attempt() {
            return Err(JobError::Retry {
                after: RETRY_AFTER,
                reason: format!(
                    "no candidates, {} provider error(s); retrying",
                    outcome.provider_errors
                ),
            });
        }
        mark_not_found(ctx, album_id).await?;
        return Ok(());
    }
    tracing::info!(album_id, torrents = linked.len(), "discovery done");
    // Проверки первой волны могли закончиться, пока мы искали остальных.
    finalize_album_from_discover(ctx, album_id).await
}

/// Все ли треки альбома из библиотеки уже найдены/скачаны.
async fn library_tracks_found(ctx: &JobCtx, album_id: i64) -> Result<bool, JobError> {
    Ok(tracks::list_by_album(&ctx.db, album_id)
        .await?
        .iter()
        .filter(|t| t.in_library)
        .all(|t| matches!(t.status, TrackStatus::Found | TrackStatus::Ready)))
}

/// Ставит `VerifyTorrent` для прилинкованных раздач, которых ещё не ставили в этом запуске.
/// Список отсортирован по рангу: лучший стартует первым, остальные — со смещением.
async fn enqueue_verifies(
    ctx: &JobCtx,
    album_id: i64,
    queued: &mut HashSet<i64>,
    delay: Duration,
) -> Result<(), JobError> {
    let linked = album_torrents::list_for_album(&ctx.db, album_id).await?;
    let now = Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
    let fresh: Vec<_> = linked
        .iter()
        .filter(|t| !queued.contains(&t.torrent.id))
        .collect();
    for (i, t) in fresh.into_iter().enumerate() {
        let at = now + chrono::Duration::from_std(VERIFY_STAGGER * i as u32).unwrap_or_default();
        jobs::enqueue(
            &ctx.db,
            &Job::VerifyTorrent {
                torrent_id: t.torrent.id,
                album_id,
            },
            Some(at),
        )
        .await?;
        queued.insert(t.torrent.id);
    }
    Ok(())
}

pub async fn discover_artist(ctx: &JobCtx, artist_id: i64) -> Result<(), JobError> {
    let artist = artists::get(&ctx.db, artist_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("artist {artist_id} not found")))?;
    let lib_albums: Vec<Album> = albums::list_by_artist(&ctx.db, artist_id)
        .await?
        .into_iter()
        .filter(|a| a.in_library)
        .collect();
    if lib_albums.is_empty() {
        return Ok(());
    }

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
    let outcome = search_and_rank(
        ctx,
        &queries,
        &input,
        None,
        |c| classify(&c.title, name, "") == TorrentKind::Discography,
        DISCOGRAPHY_MIN_SCORE,
    )
    .await;

    let stored = persist_all(ctx, &outcome.ranked, |_| TorrentKind::Discography).await?;
    for (s, t) in &stored {
        let rank = (s.score + DISCOGRAPHY_LINK_BONUS).min(1.0);
        for a in &lib_albums {
            album_torrents::link(&ctx.db, a.id, t.id, &s.query, rank).await?;
        }
    }

    // Альбомные раздачи ищет DiscoverAlbum; растягиваем по времени, чтобы не долбить трекеры.
    let now = Utc::now();
    for (i, a) in lib_albums.iter().enumerate() {
        let at = now + chrono::Duration::from_std(ALBUM_JOB_STAGGER * i as u32).unwrap_or_default();
        jobs::enqueue(&ctx.db, &Job::DiscoverAlbum { album_id: a.id }, Some(at)).await?;
    }
    tracing::info!(
        artist_id,
        discographies = outcome.ranked.len(),
        albums = lib_albums.len(),
        "artist discovery done"
    );
    Ok(())
}
