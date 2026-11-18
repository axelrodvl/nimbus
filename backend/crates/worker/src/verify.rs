//! Задача `VerifyTorrent`: список файлов раздачи → matcher → `track_sources` → статусы треков.

use std::time::Duration;

use async_trait::async_trait;
use nimbus_core::events::{Event, JobStage};
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND, PRIORITY_NORMAL};
use nimbus_core::model::{
    InfoHash, MetaStatus, NewTorrentFile, NewTrackSource, NotFoundReason, Torrent, TrackStatus,
};
use nimbus_db::repo::jobs::EnqueueOpts;
use nimbus_db::repo::{
    acquisition, album_torrents, albums, artists, cue_candidates, jobs, pins, torrents,
    track_sources, tracks,
};
use nimbus_matcher::{match_album, AlbumInput, FileInput, MatchConfig, MatchOutcome, TrackInput};
use nimbus_torrent::{parse_torrent_file, EngineError, TorrentMeta};

use crate::runner::{JobCtx, JobError, JobHandler};

/// Паузы перед повторами после таймаута метаданных: после 1-й, 2-й и 3-й неудачи.
pub const RETRY_SCHEDULE: [Duration; 3] = [
    Duration::from_secs(60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(30 * 60),
];
/// Сколько раз пробуем получить метаданные, прежде чем считать раздачу мёртвой. Одна попытка —
/// один сетевой запрос, сколько бы задач (по альбомам дискографии) его ни ждало:
/// первая попытка и по одной на каждую паузу [`RETRY_SCHEDULE`]; следующая неудача — `dead`.
pub const MAX_META_ATTEMPTS: i32 = RETRY_SCHEDULE.len() as i32 + 1;

/// Пауза перед повтором после `attempts`-й неудачной попытки (нумерация с 1).
pub fn retry_delay(attempts: i32) -> Duration {
    let i = usize::try_from(attempts.max(1) - 1).unwrap_or(0);
    RETRY_SCHEDULE[i.min(RETRY_SCHEDULE.len() - 1)]
}

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

    /// Раздача так и не проверена: помечаем проверенной (иначе альбом навсегда ждал бы её),
    /// а если метаданные не получены — раздача `error`; затем альбом финализируется
    /// (оставшиеся `adding` → `not_found`).
    async fn on_exhausted(
        &self,
        job: &Job,
        ctx: &JobCtx,
        reason: &str,
        _fatal: bool,
    ) -> Result<(), JobError> {
        let Job::VerifyTorrent {
            torrent_id,
            album_id,
        } = job
        else {
            return Ok(());
        };
        if let Some(t) = torrents::get(&ctx.db, *torrent_id).await? {
            if t.meta_status != MetaStatus::Ok {
                torrents::set_meta_status(&ctx.db, t.id, MetaStatus::Error, Some(reason)).await?;
            }
        }
        album_torrents::mark_verified(&ctx.db, *album_id, *torrent_id).await?;
        publish_progress(ctx, *album_id).await?;
        finalize_album(ctx, *album_id).await
    }
}

struct FileList(Vec<nimbus_core::model::TorrentFile>);

/// Записывает список файлов раздачи и `meta_status = ok`. Вызывается, только когда файлов у раздачи
/// ещё не было, поэтому связи с другими альбомами, «проверенные» без файлов (раздача была мёртвой
/// и ожила при повторе одного альбома дискографии), открываются заново и получают свою проверку.
pub(crate) async fn store_files(
    ctx: &JobCtx,
    torrent_id: i64,
    meta: &TorrentMeta,
) -> Result<(), JobError> {
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
    torrents::replace_files(&ctx.db, torrent_id, &new).await?;
    torrents::set_meta_status(&ctx.db, torrent_id, MetaStatus::Ok, None).await?;
    if new.is_empty() {
        return Ok(());
    }
    // Связь и её задача — одна транзакция: непроверенная связь без задачи держала бы финализацию.
    let mut tx = ctx.db.begin().await?;
    let reopened = album_torrents::reopen_verified(&mut *tx, torrent_id).await?;
    for album_id in &reopened {
        jobs::enqueue(
            &mut *tx,
            &Job::VerifyTorrent {
                torrent_id,
                album_id: *album_id,
            },
            EnqueueOpts::priority(PRIORITY_BACKGROUND),
        )
        .await?;
    }
    tx.commit().await?;
    if !reopened.is_empty() {
        tracing::info!(
            torrent_id,
            albums = reopened.len(),
            "torrent got its files; albums verified without them are re-verified"
        );
    }
    Ok(())
}

/// Файлы раздачи: из БД (`meta_status = ok`), из сохранённого `.torrent` (без сети) или через
/// fetcher (тогда `.torrent` сохраняется). Пустой список — «проверено, ничего нет».
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

    // Готовый `.torrent` в БД — сеть не нужна. Неразбираемый файл не фатален: идём в сеть.
    if torrent.has_torrent_file {
        if let Some(bytes) = torrents::torrent_file(&ctx.db, torrent.id).await? {
            let expected = InfoHash::parse(&torrent.info_hash).ok();
            match parse_torrent_file(&bytes, expected.as_ref()) {
                Ok(meta) => {
                    store_files(ctx, torrent.id, &meta).await?;
                    return Ok(FileList(torrents::files(&ctx.db, torrent.id).await?));
                }
                Err(e) => tracing::warn!(
                    torrent_id = torrent.id,
                    error = %e,
                    "stored torrent file is unusable, fetching metadata from the network"
                ),
            }
        }
    }

    let fetcher = ctx.fetcher()?;
    // Сеть — по одной задаче на раздачу: у дискографии столько задач, сколько альбомов, и каждая
    // тратила бы свою «попытку» на один и тот же запрос.
    let attempts_before = torrent.meta_attempts;
    let _guard = ctx.run(ctx.meta_locks.lock(torrent.id)).await?;
    let fresh = torrents::get(&ctx.db, torrent.id)
        .await?
        .ok_or_else(|| JobError::Fatal(format!("torrent {} not found", torrent.id)))?;
    match fresh.meta_status {
        MetaStatus::Ok => {
            let files = torrents::files(&ctx.db, fresh.id).await?;
            if !files.is_empty() {
                return Ok(FileList(files));
            }
        }
        MetaStatus::Dead | MetaStatus::Error => return Ok(FileList(vec![])),
        // Другая задача только что потратила попытку на этот же запрос — не повторяем его сразу.
        MetaStatus::Timeout if fresh.meta_attempts > attempts_before => {
            return Err(JobError::Retry {
                after: retry_delay(fresh.meta_attempts),
                reason: format!("metadata timeout (attempt {})", fresh.meta_attempts),
            });
        }
        // Попытку потратили ещё до нашего чтения раздачи (задача взята позже: альбомов больше, чем
        // воркеров), а пауза расписания не прошла — ждём её остаток, а не сжигаем следующую попытку.
        MetaStatus::Timeout => {
            if let Some(wait) = ctx.meta_cooldowns.remaining(torrent.id) {
                return Err(JobError::Retry {
                    after: ctx.unscaled(wait),
                    reason: format!(
                        "metadata timeout (attempt {}), waiting out the pause",
                        fresh.meta_attempts
                    ),
                });
            }
        }
        _ => {}
    }
    let t = torrents::set_meta_status(&ctx.db, torrent.id, MetaStatus::Fetching, None).await?;
    match ctx.run(fetcher.fetch_metadata(&t.magnet)).await? {
        Ok(meta) => {
            ctx.meta_cooldowns.clear(t.id);
            store_files(ctx, t.id, &meta).await?;
            if let Some(bytes) = &meta.torrent_file {
                torrents::set_torrent_file(&ctx.db, t.id, bytes).await?;
            }
            Ok(FileList(torrents::files(&ctx.db, t.id).await?))
        }
        Err(EngineError::MetadataTimeout) => {
            if t.meta_attempts < MAX_META_ATTEMPTS {
                torrents::set_meta_status(&ctx.db, t.id, MetaStatus::Timeout, None).await?;
                // Пауза до следующей попытки — общая для всех задач этой раздачи.
                ctx.meta_cooldowns
                    .start(t.id, ctx.scaled(retry_delay(t.meta_attempts)));
                Err(JobError::Retry {
                    after: retry_delay(t.meta_attempts),
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

/// Сопоставляет файлы раздачи с треками альбома (matcher с порогами из настроек). Общая часть
/// проверки раздачи и ручного выбора раздачи для альбома (`POST /api/albums/{id}/torrents/{torrent_id}/use`).
pub fn match_files(
    files: &[nimbus_core::model::TorrentFile],
    artist: &str,
    album: &nimbus_core::model::Album,
    album_tracks: &[nimbus_core::model::Track],
    matching: &nimbus_core::settings::MatchingSettings,
) -> MatchOutcome {
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
    match_album(
        &file_inputs,
        &AlbumInput {
            artist,
            title: &album.title,
            year: album.year,
            total_discs,
            tracks: &inputs,
        },
        &MatchConfig {
            accept: matching.accept as f32,
            confirm: matching.confirm as f32,
            ..MatchConfig::default()
        },
    )
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
        let outcome = match_files(
            &files,
            &artist.name,
            &album,
            &album_tracks,
            &ctx.settings.get().matching,
        );

        // Все записи — пакетом и в одной транзакции под блокировкой альбома: параллельные verify
        // одного альбома не гоняются за primary.
        let sources: Vec<NewTrackSource> = outcome
            .matches
            .iter()
            .map(|m| NewTrackSource {
                track_id: m.track_id,
                torrent_id,
                file_index: m.file_index as i32,
                match_score: m.score,
                needs_confirmation: m.needs_confirmation,
                cue_start_ms: None,
                cue_end_ms: None,
            })
            .collect();
        let mut track_ids: Vec<i64> = sources.iter().map(|s| s.track_id).collect();
        track_ids.sort_unstable();
        track_ids.dedup();
        let mut tx = ctx.db.begin().await?;
        sqlx::query("SELECT id FROM albums WHERE id = $1 FOR UPDATE")
            .bind(album_id)
            .fetch_optional(&mut *tx)
            .await?;
        track_sources::insert_many(&mut *tx, &sources).await?;
        // Primary — лучший источник (сначала уверенные, затем по оценке); существующий не меняется.
        track_sources::ensure_primaries(&mut *tx, &track_ids).await?;
        let found = tracks::mark_found(&mut *tx, &track_ids).await?;
        // Новый источник оживляет закрепления, у которых прежние источники зависли (B04).
        let revived = pins::requeue_stalled_for_tracks(&mut *tx, &track_ids).await?;
        tx.commit().await?;
        if !revived.is_empty() {
            // Закрепление вернулось в очередь — будим менеджер загрузок и обновляем статус альбома.
            tracing::info!(
                album_id,
                pins = revived.len(),
                "stalled pins revived by a new source"
            );
            ctx.events.publish_acquisition_changed(album_id);
        }
        for t in found {
            ctx.events.publish(Event::TrackStatus {
                track_id: t.id,
                album_id: t.album_id,
                status: t.status,
                reason: t.status_reason.clone(),
            });
        }
        for c in &outcome.cue_candidates {
            tracing::info!(torrent_id, album_id, dir = %c.dir, "cue image candidate");
            // Кандидат и его задача — одна транзакция: иначе сбой между ними оставил бы кандидата без задачи.
            let mut tx = ctx.db.begin().await?;
            cue_candidates::upsert(
                &mut *tx,
                torrent_id,
                album_id,
                c.cue_file_index as i32,
                c.image_file_index as i32,
            )
            .await?;
            jobs::enqueue(
                &mut *tx,
                &Job::ProcessCue {
                    torrent_id,
                    album_id,
                    cue_file_index: c.cue_file_index as i32,
                },
                EnqueueOpts::process_cue(ctx.priority),
            )
            .await?;
            tx.commit().await?;
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
        .filter(|t| t.wanted())
        .all(|t| matches!(t.status, TrackStatus::Found | TrackStatus::Ready));
    if all_found {
        jobs::demote_queued_verifies(&ctx.db, album_id, PRIORITY_BACKGROUND).await?;
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
    finalize(ctx, album_id, None).await
}

/// Страховка от «зависших» альбомов. У альбома с треками `adding` и без активного поиска
/// (`discover_album`/`discover_artist`) решение могло не быть принято по двум причинам:
/// 1. две задачи поиска закончились одновременно, и каждая отложила решение другой;
/// 2. непроверенной раздаче или неразобранному CUE-образу не хватает задачи (её потеряли) —
///    тогда `finalize` выходит вечно.
///
/// Обслуживание раз в тик сначала восстанавливает потерянные `verify_torrent`/`process_cue`
/// ([`requeue_lost_jobs`] — по всей библиотеке, а не только у зависших альбомов), затем для каждого
/// зависшего альбома зовёт `finalize` (он сам проверяет непроверенные раздачи, CUE и активный поиск).
/// Ошибка одного альбома логируется и не мешает остальным. Возвращает число успешно обработанных альбомов.
pub async fn finalize_stuck_albums(
    ctx: &JobCtx,
    grace: std::time::Duration,
) -> Result<usize, JobError> {
    if let Err(e) = requeue_lost_jobs(ctx).await {
        tracing::error!(error = %e, "re-enqueueing lost verify/cue jobs failed");
    }
    let ids = tracks::albums_stuck_in_adding(&ctx.db, grace).await?;
    let mut done = 0;
    for id in ids {
        match finalize_album(ctx, id).await {
            Ok(()) => done += 1,
            Err(e) => tracing::error!(album_id = id, error = %e, "stuck album handling failed"),
        }
    }
    Ok(done)
}

/// Сколько потерянных задач каждого вида восстанавливается за один проход.
const LOST_JOBS_BATCH: i64 = 500;

/// Ставит `verify_torrent` непроверенным раздачам и `process_cue` неразобранным CUE-образам, у которых
/// нет активной задачи (и нет активного поиска, который поставил бы её сам). Штатно связь и её
/// задача создаются вместе; сюда попадает то, что потеряно: сорвавшийся хук исчерпания (БД была
/// недоступна), сбой между привязкой раздачи и постановкой проверки. `warn` с `album_id` — сигнал
/// о дыре, а не штатный путь. Возвращает, сколько задач поставлено.
pub async fn requeue_lost_jobs(ctx: &JobCtx) -> Result<usize, JobError> {
    let mut n = 0;
    for (album_id, torrent_id) in album_torrents::lost_verifies(&ctx.db, LOST_JOBS_BATCH).await? {
        let job = Job::VerifyTorrent {
            torrent_id,
            album_id,
        };
        if jobs::enqueue(&ctx.db, &job, EnqueueOpts::priority(PRIORITY_NORMAL))
            .await?
            .is_some()
        {
            n += 1;
            tracing::warn!(album_id, torrent_id, "lost verify_torrent job re-enqueued");
        }
    }
    for (torrent_id, album_id, cue_file_index) in
        cue_candidates::lost(&ctx.db, LOST_JOBS_BATCH).await?
    {
        let job = Job::ProcessCue {
            torrent_id,
            album_id,
            cue_file_index,
        };
        if jobs::enqueue(&ctx.db, &job, EnqueueOpts::process_cue(PRIORITY_NORMAL))
            .await?
            .is_some()
        {
            n += 1;
            tracing::warn!(
                album_id,
                torrent_id,
                cue_file_index,
                "lost process_cue job re-enqueued"
            );
        }
    }
    Ok(n)
}

/// То же, но вызывается самой задачей поиска (`discover_album`/`discover_artist`) перед
/// завершением: её собственная запись (`own_key` — её `dedup_key`) ещё `running`, поэтому её
/// при проверке «идёт поиск» не учитываем; другой поиск этого альбома или артиста — учитываем.
pub(crate) async fn finalize_album_from_discover(
    ctx: &JobCtx,
    album_id: i64,
    own_key: &str,
) -> Result<(), JobError> {
    finalize(ctx, album_id, Some(own_key)).await
}

async fn finalize(ctx: &JobCtx, album_id: i64, own_key: Option<&str>) -> Result<(), JobError> {
    let mut tx = ctx.db.begin().await?;
    sqlx::query("SELECT id FROM albums WHERE id = $1 FOR UPDATE")
        .bind(album_id)
        .fetch_optional(&mut *tx)
        .await?;
    if album_torrents::count_unverified(&mut *tx, album_id).await? > 0
        || cue_candidates::count_pending(&mut *tx, album_id).await? > 0
        || jobs::has_queued_discover(&mut *tx, album_id, own_key).await?
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
    let reason = if linked.is_empty() {
        NotFoundReason::NoTorrents
    } else if all_dead {
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
    // Поиск закончен (больше нет ни непроверенных раздач, ни активных discover): итог и расписание
    // повтора. Срабатывает один раз на поиск — повторные вызовы finalize ничего не пишут.
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
