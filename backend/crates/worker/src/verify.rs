//! Задача `VerifyTorrent`: список файлов раздачи → matcher → `track_sources` → статусы треков.

use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::events::{Event, JobStage};
use nimbus_core::jobs::Job;
use nimbus_core::model::{
    MetaStatus, NewTorrentFile, NewTrackSource, NotFoundReason, Torrent, TrackStatus,
};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::{
    album_torrents, albums, artists, cue_candidates, jobs, torrents, track_sources, tracks,
};
use nimbus_matcher::{match_album, AlbumInput, FileInput, MatchConfig, TrackInput};
use nimbus_torrent::EngineError;

use crate::runner::{JobCtx, JobError, JobHandler};

/// Сколько раз пробуем получить метаданные, прежде чем считать раздачу мёртвой.
pub const MAX_META_ATTEMPTS: i32 = 3;
/// Пауза перед повтором после таймаута: `RETRY_STEP * meta_attempts`.
pub const RETRY_STEP: Duration = Duration::from_secs(15 * 60);
/// Резервные источники проверяются с низким приоритетом, когда все треки уже найдены.
pub const LOW_PRIORITY_DELAY: Duration = Duration::from_secs(10 * 60);

pub struct VerifyHandler;

#[async_trait]
impl JobHandler for VerifyHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::VERIFY_TORRENT]
    }

    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        match job {
            Job::VerifyTorrent {
                torrent_id,
                album_id,
            } => verify_torrent(ctx, torrent_id, album_id).await,
            _ => Err(JobError::Fatal("unexpected job kind".into())),
        }
    }
}

struct FileList(Vec<nimbus_core::model::TorrentFile>);

/// Файлы раздачи: из БД (`meta_status = ok`) или через fetcher. Пустой список — «проверено, ничего нет».
async fn load_files(ctx: &JobCtx, torrent: &Torrent) -> Result<FileList, JobError> {
    match torrent.meta_status {
        MetaStatus::Ok => {
            let files = torrents::files(&ctx.db, torrent.id).await?;
            if !files.is_empty() {
                return Ok(FileList(files));
            }
        }
        // Раздача уже признана мёртвой/некорректной — сеть не трогаем.
        MetaStatus::Dead | MetaStatus::Error => return Ok(FileList(vec![])),
        _ => {}
    }

    let fetcher = ctx.fetcher()?;
    let t = torrents::set_meta_status(&ctx.db, torrent.id, MetaStatus::Fetching, None).await?;
    match fetcher.fetch_metadata(&t.magnet).await {
        Ok(meta) => {
            let new: Vec<NewTorrentFile> = meta
                .files
                .iter()
                .map(|f| NewTorrentFile {
                    file_index: f.index as i32,
                    ext: nimbus_matcher::filename::extension(&f.path),
                    path: f.path.clone(),
                    size_bytes: i64::try_from(f.size).unwrap_or(i64::MAX),
                })
                .collect();
            torrents::replace_files(&ctx.db, t.id, &new).await?;
            torrents::set_meta_status(&ctx.db, t.id, MetaStatus::Ok, None).await?;
            Ok(FileList(torrents::files(&ctx.db, t.id).await?))
        }
        Err(EngineError::MetadataTimeout) => {
            if t.meta_attempts < MAX_META_ATTEMPTS {
                torrents::set_meta_status(&ctx.db, t.id, MetaStatus::Timeout, None).await?;
                Err(JobError::Retry {
                    after: RETRY_STEP * t.meta_attempts.max(1) as u32,
                    reason: format!("metadata timeout (attempt {})", t.meta_attempts),
                })
            } else {
                torrents::set_meta_status(
                    &ctx.db,
                    t.id,
                    MetaStatus::Dead,
                    Some("metadata timeout"),
                )
                .await?;
                Ok(FileList(vec![]))
            }
        }
        Err(e) => {
            torrents::set_meta_status(&ctx.db, t.id, MetaStatus::Error, Some(&e.to_string()))
                .await?;
            Ok(FileList(vec![]))
        }
    }
}

pub async fn verify_torrent(ctx: &JobCtx, torrent_id: i64, album_id: i64) -> Result<(), JobError> {
    let torrent = torrents::get(&ctx.db, torrent_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("torrent {torrent_id} not found")))?;
    let album = albums::get(&ctx.db, album_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("album {album_id} not found")))?;
    let artist = artists::get(&ctx.db, album.artist_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("artist {} not found", album.artist_id)))?;

    publish_progress(ctx, album_id).await?;
    let FileList(files) = load_files(ctx, &torrent).await?;

    // Сопоставляем со всеми треками альбома, кроме уже скачанных.
    let album_tracks: Vec<_> = tracks::list_by_album(&ctx.db, album_id)
        .await?
        .into_iter()
        .filter(|t| t.status != TrackStatus::Ready)
        .collect();
    if !files.is_empty() && !album_tracks.is_empty() {
        let inputs: Vec<TrackInput> = album_tracks
            .iter()
            .map(|t| TrackInput {
                id: t.id,
                title: t.title.clone(),
                disc_no: t.disc_no,
                position: t.position,
                duration_ms: t.duration_ms,
            })
            .collect();
        let file_inputs: Vec<FileInput> = files
            .iter()
            .map(|f| FileInput {
                index: f.file_index as usize,
                path: f.path.clone(),
                size: f.size_bytes.max(0) as u64,
            })
            .collect();
        let total_discs = album_tracks
            .iter()
            .map(|t| t.disc_no)
            .max()
            .unwrap_or(1)
            .max(1);
        let outcome = match_album(
            &file_inputs,
            &AlbumInput {
                artist: &artist.name,
                title: &album.title,
                year: album.year,
                total_discs,
                tracks: &inputs,
            },
            &{
                let m = &ctx.settings.get().matching;
                MatchConfig {
                    accept: m.accept as f32,
                    confirm: m.confirm as f32,
                    ..MatchConfig::default()
                }
            },
        );

        for m in &outcome.matches {
            track_sources::insert(
                &ctx.db,
                &NewTrackSource {
                    track_id: m.track_id,
                    torrent_id,
                    file_index: m.file_index as i32,
                    match_score: m.score,
                    needs_confirmation: m.needs_confirmation,
                    cue_start_ms: None,
                    cue_end_ms: None,
                },
            )
            .await?;
            // Primary: лучший источник (сначала уверенные, затем по оценке); существующий не меняем.
            if track_sources::primary_for_track(&ctx.db, m.track_id)
                .await?
                .is_none()
            {
                let best = track_sources::list_for_track(&ctx.db, m.track_id)
                    .await?
                    .into_iter()
                    .min_by(|a, b| {
                        a.needs_confirmation
                            .cmp(&b.needs_confirmation)
                            .then(b.match_score.total_cmp(&a.match_score))
                            .then(a.id.cmp(&b.id))
                    });
                if let Some(best) = best {
                    track_sources::set_primary(&ctx.db, m.track_id, best.id).await?;
                }
            }
            let status = album_tracks
                .iter()
                .find(|t| t.id == m.track_id)
                .map(|t| t.status);
            if matches!(status, Some(TrackStatus::Adding | TrackStatus::NotFound)) {
                set_track_status_and_publish(
                    &ctx.db,
                    &ctx.events,
                    m.track_id,
                    TrackStatus::Found,
                    None,
                )
                .await?;
            }
        }
        for c in &outcome.cue_candidates {
            tracing::info!(torrent_id, album_id, dir = %c.dir, "cue image candidate");
            cue_candidates::upsert(
                &ctx.db,
                torrent_id,
                album_id,
                c.cue_file_index as i32,
                c.image_file_index as i32,
            )
            .await?;
            jobs::enqueue(
                &ctx.db,
                &Job::ProcessCue {
                    torrent_id,
                    album_id,
                    cue_file_index: c.cue_file_index as i32,
                },
                None,
            )
            .await?;
        }
        tracing::info!(
            torrent_id,
            album_id,
            matched = outcome.matches.len(),
            unmatched = outcome.unmatched_track_ids.len(),
            "torrent verified"
        );
    }

    // Все треки библиотеки найдены — оставшиеся кандидаты дают лишь резервные источники.
    let all_found = tracks::list_by_album(&ctx.db, album_id)
        .await?
        .iter()
        .filter(|t| t.in_library)
        .all(|t| matches!(t.status, TrackStatus::Found | TrackStatus::Ready));
    if all_found {
        jobs::defer_queued_verifies(&ctx.db, album_id, LOW_PRIORITY_DELAY).await?;
    }

    album_torrents::mark_verified(&ctx.db, album_id, torrent_id).await?;
    publish_progress(ctx, album_id).await?;
    finalize_album(ctx, album_id).await
}

async fn publish_progress(ctx: &JobCtx, album_id: i64) -> Result<(), JobError> {
    let (total, done) = album_torrents::progress(&ctx.db, album_id).await?;
    ctx.events.publish(Event::JobProgress {
        album_id,
        stage: JobStage::Verifying,
        done: done as u32,
        total: total as u32,
    });
    Ok(())
}

/// Если все раздачи альбома проверены, оставшиеся `adding` → `not_found`.
/// Транзакция с блокировкой строки альбома: параллельные verify не конфликтуют.
pub(crate) async fn finalize_album(ctx: &JobCtx, album_id: i64) -> Result<(), JobError> {
    let mut tx = ctx.db.begin().await?;
    sqlx::query("SELECT id FROM albums WHERE id = $1 FOR UPDATE")
        .bind(album_id)
        .fetch_optional(&mut *tx)
        .await?;
    if album_torrents::count_unverified(&mut *tx, album_id).await? > 0
        || cue_candidates::count_pending(&mut *tx, album_id).await? > 0
        || jobs::has_queued_discover(&mut *tx, album_id).await?
    {
        tx.commit().await?;
        return Ok(());
    }
    let linked = album_torrents::list_for_album(&mut *tx, album_id).await?;
    let all_dead = !linked.is_empty()
        && linked.iter().all(|t| {
            matches!(
                t.torrent.meta_status,
                MetaStatus::Timeout | MetaStatus::Dead | MetaStatus::Error
            )
        });
    let reason = if all_dead {
        NotFoundReason::DeadTorrents
    } else {
        NotFoundReason::NoMatch
    };
    let changed = tracks::set_status_for_album(
        &mut *tx,
        album_id,
        &[TrackStatus::Adding],
        TrackStatus::NotFound,
        Some(reason),
    )
    .await?;
    tx.commit().await?;
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
