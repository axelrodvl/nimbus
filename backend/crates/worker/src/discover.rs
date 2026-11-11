//! Задачи `DiscoverAlbum` и `DiscoverArtist`: поиск раздач у провайдеров, ранжирование,
//! сохранение в `torrents`/`album_torrents` и постановка `VerifyTorrent`.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
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

/// Сколько лучших кандидатов сохраняем и проверяем (шаг 22 сделает настройкой).
pub const TOP_N: usize = 8;
/// Через сколько повторять поиск, если провайдеры упали и кандидатов нет.
pub const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
/// Минимальный балл дискографии (без учёта альбома).
pub const DISCOGRAPHY_MIN_SCORE: f32 = 0.2;
/// Небольшой бонус к баллу дискографии при привязке к альбомам.
pub const DISCOGRAPHY_LINK_BONUS: f32 = 0.05;
/// Пауза между постановкой `DiscoverAlbum` для альбомов артиста.
pub const ALBUM_JOB_STAGGER: Duration = Duration::from_secs(5);
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
    let prefs = FormatPrefs::default();
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
    for (i, q) in queries.iter().enumerate() {
        for (source, res) in ctx.providers.search_all(q).await {
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
        progress(i as u32 + 1);
    }
    let mut ranked: Vec<Scored> = best.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.cand.title.cmp(&b.cand.title))
    });
    ranked.truncate(TOP_N);
    SearchOutcome {
        ranked,
        provider_errors,
    }
}

/// `resolve` (если нужен hash) и сохранение раздачи. `None` — кандидата использовать нельзя.
async fn persist(ctx: &JobCtx, s: &Scored, kind: TorrentKind) -> Result<Option<Torrent>, JobError> {
    let mut cand = s.cand.clone();
    if cand.info_hash.is_none() {
        let Some(provider) = ctx.providers.get(cand.source) else {
            return Ok(None);
        };
        cand = match provider.resolve(cand).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(title = %s.cand.title, error = %e, "resolve failed, skipping candidate");
                return Ok(None);
            }
        };
    }
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

    for s in &outcome.ranked {
        let kind = classify(&s.cand.title, &artist.name, &album.title);
        if let Some(t) = persist(ctx, s, kind).await? {
            album_torrents::link(&ctx.db, album_id, t.id, &s.query, s.score).await?;
        }
    }

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

    for t in &linked {
        jobs::enqueue(
            &ctx.db,
            &Job::VerifyTorrent {
                torrent_id: t.torrent.id,
                album_id,
            },
            None,
        )
        .await?;
    }
    tracing::info!(album_id, torrents = linked.len(), "discovery done");
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

    for s in &outcome.ranked {
        let Some(t) = persist(ctx, s, TorrentKind::Discography).await? else {
            continue;
        };
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
