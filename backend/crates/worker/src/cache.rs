//! Учёт места и вытеснение кэша: давно не игравшие файлы удаляются, пока кэш не уменьшится до 90 % лимита.

use std::path::Path;

use async_trait::async_trait;
use nimbus_core::jobs::Job;
use nimbus_core::model::{InfoHash, TrackStatus};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::{downloads, pins, torrents, track_sources};
use nimbus_torrent::TorrentHandleId;

use crate::runner::{JobCtx, JobError, JobHandler};

/// До какой доли лимита вытесняем.
pub const TARGET_FRACTION: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub used_bytes: u64,
    pub files: i64,
    pub torrents_active: i64,
}

/// Реально занятое место файла: для разреженных (недокачанных) файлов — выделенные блоки.
pub fn on_disk_size(path: &str) -> u64 {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(m) => {
            let (len, alloc) = (m.len(), m.blocks().saturating_mul(512));
            // Некоторые ФС не сообщают блоки (0) — тогда берём длину.
            if alloc == 0 {
                len
            } else {
                len.min(alloc)
            }
        }
        Err(_) => 0,
    }
}

pub async fn usage(db: &sqlx::PgPool) -> sqlx::Result<Usage> {
    let all = downloads::list_all(db).await?;
    let mut u = Usage::default();
    let mut active = std::collections::HashSet::new();
    for d in &all {
        let size = on_disk_size(&d.local_path);
        if size > 0 {
            u.used_bytes += size;
            u.files += 1;
        }
        if d.completed_at.is_none() {
            active.insert(d.torrent_id);
        }
    }
    u.torrents_active = active.len() as i64;
    Ok(u)
}

/// Сколько места занимает закреплённое (файлы, являющиеся primary-источником закреплённых треков).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PinnedUsage {
    pub bytes: u64,
    pub files: i64,
}

pub async fn pinned_usage(db: &sqlx::PgPool) -> sqlx::Result<PinnedUsage> {
    let pinned = pins::protected_files(db).await?;
    let mut u = PinnedUsage::default();
    if pinned.is_empty() {
        return Ok(u);
    }
    for d in downloads::list_all(db).await? {
        if !pinned.contains(&(d.torrent_id, d.file_index)) {
            continue;
        }
        let size = on_disk_size(&d.local_path);
        if size > 0 {
            u.bytes += size;
            u.files += 1;
        }
    }
    Ok(u)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EvictReport {
    pub used_before: u64,
    pub used_after: u64,
    pub evicted: Vec<(i64, i32)>,
}

/// Удаляет пустые каталоги вверх от файла до каталога `torrents` (не включая).
pub fn prune_empty_dirs(file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d.file_name().is_some_and(|n| n == "torrents") {
            break;
        }
        if std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

pub async fn evict_cache(ctx: &JobCtx, limit_bytes: u64) -> Result<EvictReport, JobError> {
    let all = downloads::list_all(&ctx.db).await?;
    let sizes: Vec<u64> = all.iter().map(|d| on_disk_size(&d.local_path)).collect();
    let used: u64 = sizes.iter().sum();
    let mut report = EvictReport {
        used_before: used,
        used_after: used,
        evicted: vec![],
    };
    if used <= limit_bytes {
        return Ok(report);
    }
    let target = (limit_bytes as f64 * TARGET_FRACTION) as u64;
    // Закреплённое не вытесняется никогда (шаг 33).
    let pinned = pins::protected_files(&ctx.db).await?;
    let mut skipped_pinned = 0usize;

    // Самые давно игравшие первыми; никогда не игравшие — по времени завершения; без обоих — раньше всех.
    let mut order: Vec<usize> = (0..all.len()).collect();
    order.sort_by_key(|&i| {
        let d = &all[i];
        (
            d.last_played_at.or(d.completed_at),
            d.torrent_id,
            d.file_index,
        )
    });

    for i in order {
        if report.used_after <= target {
            break;
        }
        let d = &all[i];
        if sizes[i] == 0 || ctx.activity.is_protected(d.torrent_id, d.file_index) {
            continue;
        }
        if pinned.contains(&(d.torrent_id, d.file_index)) {
            skipped_pinned += 1;
            continue;
        }
        if let (Some(engine), Ok(Some(t))) = (
            ctx.engine.as_ref(),
            torrents::get(&ctx.db, d.torrent_id).await,
        ) {
            if let Ok(hash) = InfoHash::parse(&t.info_hash) {
                let _ = engine
                    .release_file(&TorrentHandleId(hash), d.file_index as usize, true)
                    .await;
            }
        }
        match std::fs::remove_file(&d.local_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(path = %d.local_path, error = %e, "cannot delete cached file");
                continue;
            }
        }
        prune_empty_dirs(Path::new(&d.local_path));
        downloads::delete(&ctx.db, d.torrent_id, d.file_index).await?;
        for t in track_sources::tracks_with_primary(
            &ctx.db,
            d.torrent_id,
            d.file_index,
            TrackStatus::Ready,
        )
        .await?
        {
            set_track_status_and_publish(&ctx.db, &ctx.events, t.id, TrackStatus::Found, None)
                .await?;
        }
        report.used_after = report.used_after.saturating_sub(sizes[i]);
        report.evicted.push((d.torrent_id, d.file_index));
        tracing::info!(
            torrent_id = d.torrent_id,
            file_index = d.file_index,
            bytes = sizes[i],
            "evicted cached file"
        );
    }
    if report.used_after > limit_bytes && skipped_pinned > 0 {
        tracing::warn!(
            used = report.used_after,
            limit = limit_bytes,
            pinned_files = skipped_pinned,
            "pinned files exceed the cache limit, eviction stopped"
        );
    }
    Ok(report)
}

pub struct EvictHandler;

#[async_trait]
impl JobHandler for EvictHandler {
    fn kinds(&self) -> &'static [&'static str] {
        &[Job::EVICT_CACHE]
    }

    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError> {
        if !matches!(job, Job::EvictCache) {
            return Err(JobError::Fatal("unexpected job kind".into()));
        }
        let limit = ctx.settings.get().cache_limit_bytes();
        let r = evict_cache(ctx, limit).await?;
        if !r.evicted.is_empty() {
            tracing::info!(
                evicted = r.evicted.len(),
                before = r.used_before,
                after = r.used_after,
                "cache eviction finished"
            );
        }
        Ok(())
    }
}
