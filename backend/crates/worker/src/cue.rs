//! Задача `process_cue`: разбор CUE-файла раздачи «образ + cue» и привязка треков к отрезкам образа.

use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::jobs::Job;
use nimbus_core::model::{NewTrackSource, Torrent, TrackStatus};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::{albums, artists, cue_candidates, torrents, track_sources, tracks};
use nimbus_matcher::cue::{match_cue, parse_cue};
use nimbus_matcher::{AlbumInput, TrackInput};
use nimbus_torrent::EngineError;

use crate::runner::{JobCtx, JobError, JobHandler};
use crate::verify::finalize_album;

/// Сколько ждём скачивания CUE-файла (он весит килобайты).
pub const CUE_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(200);
const RETRY_AFTER: Duration = Duration::from_secs(60);
/// Оценка совпадения для треков, привязанных по CUE.
const CUE_SCORE: f32 = 0.9;

pub struct ProcessCueHandler;

#[async_trait]
impl JobHandler for ProcessCueHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::PROCESS_CUE]
    }

    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        let Job::ProcessCue {
            torrent_id,
            album_id,
            cue_file_index,
        } = job
        else {
            return Err(JobError::Fatal("unexpected job kind".into()));
        };
        process_cue(ctx, torrent_id, album_id, cue_file_index).await
    }

    /// Кандидат не должен блокировать финализацию альбома вечно: при исчерпании попыток или
    /// фатальной ошибке помечаем его разобранным и финализируем альбом.
    async fn on_exhausted(&self, job: &Job, ctx: &JobCtx, _reason: &str) -> Result<(), JobError> {
        let Job::ProcessCue {
            torrent_id,
            album_id,
            cue_file_index,
        } = job
        else {
            return Ok(());
        };
        cue_candidates::mark_processed(&ctx.db, *torrent_id, *album_id, *cue_file_index).await?;
        finalize_album(ctx, *album_id).await
    }
}

/// Скачивает CUE-файл и возвращает его байты.
async fn fetch_cue(
    ctx: &JobCtx,
    torrent: &Torrent,
    cue_file_index: usize,
) -> Result<Vec<u8>, JobError> {
    let files = ctx.files()?;
    let tref = crate::torrent_file::torrent_ref(&ctx.db, torrent).await?;
    let handle = ctx
        .run(files.ensure_file(&tref, cue_file_index))
        .await?
        .map_err(|e| match e {
            EngineError::MetadataTimeout => JobError::Retry {
                after: RETRY_AFTER,
                reason: "torrent metadata timeout".into(),
            },
            other => JobError::Unexpected(other.to_string()),
        })?;
    crate::torrent_file::remember_engine_file(&ctx.db, files.as_ref(), &handle, torrent).await;
    let wait = async {
        loop {
            if files
                .file_progress(&handle, cue_file_index)
                .is_some_and(|p| p.finished)
            {
                return;
            }
            tokio::time::sleep(POLL).await;
        }
    };
    if ctx
        .run(tokio::time::timeout(CUE_FETCH_TIMEOUT, wait))
        .await?
        .is_err()
    {
        return Err(JobError::Retry {
            after: RETRY_AFTER,
            reason: "cue file download timeout".into(),
        });
    }
    let path = files
        .file_path(&handle, cue_file_index)
        .ok_or_else(|| JobError::Unexpected("cue file path is unknown".into()))?;
    tokio::fs::read(&path)
        .await
        .map_err(|e| JobError::Unexpected(format!("read {}: {e}", path.display())))
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

pub async fn process_cue(
    ctx: &JobCtx,
    torrent_id: i64,
    album_id: i64,
    cue_file_index: i32,
) -> Result<(), JobError> {
    let candidate = cue_candidates::get(&ctx.db, torrent_id, album_id, cue_file_index)
        .await?
        .ok_or_else(|| JobError::Fatal("cue candidate not found".into()))?;
    if candidate.processed {
        return Ok(());
    }
    let torrent = torrents::get(&ctx.db, torrent_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("torrent {torrent_id} not found")))?;
    let album = albums::get(&ctx.db, album_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("album {album_id} not found")))?;
    let artist = artists::get(&ctx.db, album.artist_id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("artist {} not found", album.artist_id)))?;
    let files = torrents::files(&ctx.db, torrent_id).await?;

    let bytes = fetch_cue(ctx, &torrent, cue_file_index as usize).await?;
    let sheet = match parse_cue(&bytes) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(torrent_id, album_id, error = %e, "cue sheet is unusable");
            return Err(JobError::Fatal(format!("bad cue sheet: {e}")));
        }
    };

    let album_tracks: Vec<_> = tracks::list_by_album(&ctx.db, album_id)
        .await?
        .into_iter()
        .filter(|t| t.status != TrackStatus::Ready)
        .collect();
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
    let total_discs = album_tracks
        .iter()
        .map(|t| t.disc_no)
        .max()
        .unwrap_or(1)
        .max(1);
    let matches = match_cue(
        &sheet,
        &AlbumInput {
            artist: &artist.name,
            title: &album.title,
            year: album.year,
            total_discs,
            tracks: &inputs,
        },
    );

    let single_file = sheet.files.len() == 1;
    let mut linked = 0;
    for m in &matches {
        // Имя файла из CUE → файл раздачи; один FILE и один образ — напрямую.
        let wanted = basename(&m.file_name);
        let file_index = files
            .iter()
            .find(|f| basename(&f.path) == wanted)
            .map(|f| f.file_index)
            .or_else(|| single_file.then_some(candidate.image_file_index));
        let Some(file_index) = file_index else {
            tracing::warn!(torrent_id, file = %m.file_name, "cue FILE is not in the torrent");
            continue;
        };
        let source = track_sources::insert(
            &ctx.db,
            &NewTrackSource {
                track_id: m.track_id,
                torrent_id,
                file_index,
                match_score: CUE_SCORE,
                needs_confirmation: false,
                cue_start_ms: Some(m.start_ms as i32),
                cue_end_ms: m.end_ms.map(|e| e as i32),
            },
        )
        .await?;
        if track_sources::primary_for_track(&ctx.db, m.track_id)
            .await?
            .is_none()
        {
            track_sources::set_primary(&ctx.db, m.track_id, source.id).await?;
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
        linked += 1;
    }
    tracing::info!(torrent_id, album_id, linked, "cue image processed");

    cue_candidates::mark_processed(&ctx.db, torrent_id, album_id, cue_file_index).await?;
    // Финализация альбома ждала разбора всех CUE-кандидатов.
    finalize_album(ctx, album_id).await
}
