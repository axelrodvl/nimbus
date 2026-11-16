//! Повтор поиска раздач альбома: один код для ручного повтора (альбом, трек, массовый) и
//! автоматического (`RetryMissing`).

use nimbus_core::events::{Event, EventBus};
use nimbus_core::jobs::Job;
use nimbus_core::model::{Track, TrackStatus};
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use nimbus_db::repo::{acquisition, album_torrents, cue_candidates, tracks};
use sqlx::{PgConnection, PgPool};

/// Параметры повтора.
#[derive(Debug, Clone, Copy)]
pub struct RetryOptions {
    /// Приоритет поиска (`PRIORITY_INTERACTIVE` — ручной, `PRIORITY_BACKGROUND` — авто).
    pub priority: i16,
    /// Вернуть раздачам альбома с `dead|timeout|error` статус `pending` — их проверят заново.
    /// Без флага сбрасываются только раздачи с таймаутом метаданных.
    pub reset_dead: bool,
    /// Ручной запуск: начать счёт авто-повторов заново (`auto_retries = 0`).
    pub manual: bool,
}

/// Что сделал повтор.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryReport {
    /// Поставлена новая задача поиска (`false` — такая уже в очереди; её приоритет мог вырасти).
    pub queued: bool,
    /// Сколько треков вернулось из `not_found` в `adding`.
    pub tracks_reset: usize,
}

/// Повтор поиска альбома в чужой транзакции: треки `not_found` → `adding`, раздачи для перепроверки
/// сброшены, `DiscoverAlbum` в очереди. Возвращает изменённые треки (о них нужно сообщить после
/// коммита — [`publish_tracks`]) и признак «поставлена новая задача».
pub async fn retry_album_in(
    conn: &mut PgConnection,
    album_id: i64,
    opts: RetryOptions,
) -> sqlx::Result<(Vec<Track>, bool)> {
    let changed = tracks::set_status_for_album(
        &mut *conn,
        album_id,
        &[TrackStatus::NotFound],
        TrackStatus::Adding,
        None,
    )
    .await?;
    if opts.reset_dead {
        album_torrents::reset_dead(&mut *conn, album_id).await?;
    } else {
        album_torrents::reset_verified_timeouts(&mut *conn, album_id).await?;
    }
    if opts.reset_dead {
        // CUE-образы, разбор которых сорвался по временной причине, получают новую попытку.
        for (torrent_id, cue_file_index) in
            cue_candidates::reset_failed(&mut *conn, album_id).await?
        {
            jobs::enqueue(
                &mut *conn,
                &Job::ProcessCue {
                    torrent_id,
                    album_id,
                    cue_file_index,
                },
                EnqueueOpts::process_cue(opts.priority),
            )
            .await?;
        }
    }
    if opts.manual {
        acquisition::reset_auto_retries(&mut *conn, album_id).await?;
    }
    let queued = jobs::enqueue(
        &mut *conn,
        &Job::DiscoverAlbum { album_id },
        EnqueueOpts::priority(opts.priority),
    )
    .await?
    .is_some();
    Ok((changed, queued))
}

/// Публикует `track.status` для треков, изменённых [`retry_album_in`] (после коммита).
pub fn publish_tracks(events: &EventBus, changed: &[Track]) {
    for t in changed {
        events.publish(Event::TrackStatus {
            track_id: t.id,
            album_id: t.album_id,
            status: t.status,
            reason: t.status_reason.clone(),
        });
    }
}

/// Повтор поиска альбома одной транзакцией (альбом не останется в `adding` без задачи).
/// Уже проверенные раздачи заново не проверяются: поиск добавит только новых кандидатов.
pub async fn retry_album(
    db: &PgPool,
    events: &EventBus,
    album_id: i64,
    opts: RetryOptions,
) -> sqlx::Result<RetryReport> {
    let mut tx = db.begin().await?;
    let (changed, queued) = retry_album_in(&mut tx, album_id, opts).await?;
    tx.commit().await?;
    publish_tracks(events, &changed);
    Ok(RetryReport {
        queued,
        tracks_reset: changed.len(),
    })
}

/// Ставит поиск альбома, не трогая статусы остальных треков (повтор одного трека: он сам уже
/// переведён в `adding`). `true` — новая задача.
pub async fn queue_search(
    db: &PgPool,
    album_id: i64,
    priority: i16,
    manual: bool,
) -> sqlx::Result<bool> {
    let mut tx = db.begin().await?;
    if manual {
        acquisition::reset_auto_retries(&mut *tx, album_id).await?;
    }
    let queued = jobs::enqueue(
        &mut *tx,
        &Job::DiscoverAlbum { album_id },
        EnqueueOpts::priority(priority),
    )
    .await?
    .is_some();
    tx.commit().await?;
    Ok(queued)
}
