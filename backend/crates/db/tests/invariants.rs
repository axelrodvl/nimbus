// Инварианты «ничего не застряло» (ревью B14): на каждый — «нарушение найдено» и «законное
// состояние нарушением не считается». unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
use std::time::Duration;

use nimbus_core::jobs::Job;
use nimbus_core::model::*;
use nimbus_db::repo::invariants::{self, Params, Section};
use nimbus_db::repo::jobs::{self, EnqueueOpts};
use nimbus_db::repo::*;
use sqlx::PgPool;
use uuid::Uuid;

const HOUR: Duration = Duration::from_secs(3600);
const ZERO: Duration = Duration::ZERO;

async fn artist(pool: &PgPool) -> i64 {
    artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "Artist".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id
}

/// Альбом в библиотеке; трек `i` получает статус `statuses[i]`. Возвращает (альбом, треки).
async fn album(pool: &PgPool, artist_id: i64, statuses: &[TrackStatus]) -> (i64, Vec<i64>) {
    let a = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id,
            title: "Album".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(2001),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    let mut ids = Vec::new();
    for (i, st) in statuses.iter().enumerate() {
        let t = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: a.id,
                artist_id,
                title: format!("Track {i}"),
                disc_no: 1,
                position: i as i32 + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        let reason = (*st == TrackStatus::NotFound).then_some(NotFoundReason::NoTorrents);
        tracks::set_status(pool, t.id, *st, reason).await.unwrap();
        ids.push(t.id);
    }
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    (a.id, ids)
}

async fn torrent(pool: &PgPool) -> i64 {
    let hash: String = Uuid::new_v4().simple().to_string() + "00000000";
    torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&hash).unwrap(),
            magnet: format!("magnet:?xt=urn:btih:{hash}"),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "Torrent".into(),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap()
    .id
}

/// Источник трека (primary) в файле `file_index` раздачи.
async fn primary(pool: &PgPool, track_id: i64, torrent_id: i64, file_index: i32) {
    let s = track_sources::insert(
        pool,
        &NewTrackSource {
            track_id,
            torrent_id,
            file_index,
            match_score: 1.0,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    track_sources::set_primary(pool, track_id, s.id)
        .await
        .unwrap();
}

async fn download(pool: &PgPool, torrent_id: i64, file_index: i32, completed: bool) {
    downloads::upsert(
        pool,
        &NewDownload {
            torrent_id,
            file_index,
            local_path: format!("/tmp/{torrent_id}-{file_index}"),
            bytes_total: 10,
            bytes_done: 0,
        },
    )
    .await
    .unwrap();
    if completed {
        downloads::mark_completed(pool, torrent_id, file_index)
            .await
            .unwrap();
    }
}

async fn enqueue(pool: &PgPool, job: Job) -> i64 {
    jobs::enqueue(pool, &job, EnqueueOpts::default())
        .await
        .unwrap()
        .unwrap()
}

/// Сдвигает отметки времени сущности в прошлое.
async fn age(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

fn ids(s: &Option<Section>) -> Vec<i64> {
    s.iter()
        .flat_map(|s| s.violations.iter().map(|v| v.id))
        .collect()
}

// ------------------------------------------------------------------ I1

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i1_adding_album_without_any_job_is_a_violation(pool: PgPool) {
    let ar = artist(&pool).await;
    let (stuck, _) = album(&pool, ar, &[TrackStatus::Adding, TrackStatus::Found]).await;
    album(&pool, ar, &[TrackStatus::Found]).await;
    let s = invariants::i1_adding_without_job(&pool, ZERO)
        .await
        .unwrap();
    assert_eq!(ids(&s), vec![stuck]);
    let s = s.unwrap();
    assert_eq!((s.invariant, s.count), ("I1", 1));
    assert_eq!(s.violations[0].entity, "album");
    assert_eq!(s.violations[0].detail, "tracks in adding: 1");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i1_respects_grace_library_flag_and_active_jobs(pool: PgPool) {
    let ar = artist(&pool).await;
    // В пределах отсрочки.
    album(&pool, ar, &[TrackStatus::Adding]).await;
    assert!(invariants::i1_adding_without_job(&pool, HOUR)
        .await
        .unwrap()
        .is_none());

    // Каждый вид активной задачи снимает нарушение.
    let t = torrent(&pool).await;
    let (a_album, _) = album(&pool, ar, &[TrackStatus::Adding]).await;
    for job in [
        Job::DiscoverAlbum { album_id: a_album },
        Job::DiscoverArtist { artist_id: ar },
        Job::VerifyTorrent {
            torrent_id: t,
            album_id: a_album,
        },
        Job::ProcessCue {
            torrent_id: t,
            album_id: a_album,
            cue_file_index: 0,
        },
    ] {
        sqlx::query("DELETE FROM jobs")
            .execute(&pool)
            .await
            .unwrap();
        let other = !matches!(job, Job::DiscoverArtist { .. });
        enqueue(&pool, job.clone()).await;
        let found = ids(&invariants::i1_adding_without_job(&pool, ZERO)
            .await
            .unwrap());
        assert!(!found.contains(&a_album), "{job:?} покрывает альбом");
        // Задача одного альбома не покрывает другой (кроме поиска по артисту).
        assert_eq!(found.len(), usize::from(other), "{job:?}");
    }

    // Трек вне библиотеки не ждёт никого.
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE tracks SET in_library = FALSE")
        .execute(&pool)
        .await
        .unwrap();
    assert!(invariants::i1_adding_without_job(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
}

// ------------------------------------------------------------------ I2

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i2_unverified_link_without_job_is_a_violation(pool: PgPool) {
    let ar = artist(&pool).await;
    let (a, _) = album(&pool, ar, &[TrackStatus::Found]).await;
    let t = torrent(&pool).await;
    album_torrents::link(&pool, a, t, "q", 0.5).await.unwrap();
    let s = invariants::i2_unverified_without_job(&pool, ZERO)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.violations[0].id, a);
    assert_eq!(s.violations[0].entity, "album_torrent");
    assert_eq!(s.violations[0].detail, format!("torrent_id={t}"));
    assert_eq!(
        album_torrents::lost_verifies(&pool, 10).await.unwrap(),
        vec![(a, t)]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i2_verified_fresh_or_covered_links_are_fine(pool: PgPool) {
    let ar = artist(&pool).await;
    let (a, _) = album(&pool, ar, &[TrackStatus::Found]).await;
    let t = torrent(&pool).await;
    album_torrents::link(&pool, a, t, "q", 0.5).await.unwrap();
    let check = |grace| invariants::i2_unverified_without_job(&pool, grace);
    assert!(check(HOUR).await.unwrap().is_none(), "свежая связь");
    for job in [
        Job::VerifyTorrent {
            torrent_id: t,
            album_id: a,
        },
        Job::DiscoverAlbum { album_id: a },
        Job::DiscoverArtist { artist_id: ar },
    ] {
        sqlx::query("DELETE FROM jobs")
            .execute(&pool)
            .await
            .unwrap();
        enqueue(&pool, job.clone()).await;
        assert!(check(ZERO).await.unwrap().is_none(), "{job:?}");
        assert!(album_torrents::lost_verifies(&pool, 10)
            .await
            .unwrap()
            .is_empty());
    }
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    album_torrents::mark_verified(&pool, a, t).await.unwrap();
    assert!(check(ZERO).await.unwrap().is_none(), "проверенная связь");
}

// ------------------------------------------------------------------ I3

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i3_pending_cue_without_job_is_a_violation(pool: PgPool) {
    let ar = artist(&pool).await;
    let (a, _) = album(&pool, ar, &[TrackStatus::Adding]).await;
    let t = torrent(&pool).await;
    cue_candidates::upsert(&pool, t, a, 3, 4).await.unwrap();
    let s = invariants::i3_cue_without_job(&pool)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.count, s.violations[0].id), (1, a));
    assert_eq!(
        s.violations[0].detail,
        format!("torrent_id={t} cue_file_index=3")
    );
    assert_eq!(
        cue_candidates::lost(&pool, 10).await.unwrap(),
        vec![(t, a, 3)]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i3_processed_or_queued_cue_is_fine(pool: PgPool) {
    let ar = artist(&pool).await;
    let (a, _) = album(&pool, ar, &[TrackStatus::Adding]).await;
    let t = torrent(&pool).await;
    cue_candidates::upsert(&pool, t, a, 3, 4).await.unwrap();
    enqueue(
        &pool,
        Job::ProcessCue {
            torrent_id: t,
            album_id: a,
            cue_file_index: 3,
        },
    )
    .await;
    assert!(invariants::i3_cue_without_job(&pool)
        .await
        .unwrap()
        .is_none());
    assert!(cue_candidates::lost(&pool, 10).await.unwrap().is_empty());
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    cue_candidates::mark_failed(&pool, t, a, 3).await.unwrap();
    assert!(invariants::i3_cue_without_job(&pool)
        .await
        .unwrap()
        .is_none());
}

// ------------------------------------------------------------------ I4

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i4_missing_album_without_schedule_is_a_violation(pool: PgPool) {
    let ar = artist(&pool).await;
    let (no_state, _) = album(&pool, ar, &[TrackStatus::NotFound, TrackStatus::Found]).await;
    let (no_schedule, _) = album(&pool, ar, &[TrackStatus::NotFound]).await;
    acquisition::reset_auto_retries(&pool, no_schedule)
        .await
        .unwrap();
    let s = invariants::i4_missing_without_schedule(&pool, ZERO)
        .await
        .unwrap();
    assert_eq!(ids(&s), vec![no_state, no_schedule]);
    assert_eq!(s.unwrap().violations[0].detail, "tracks not_found: 1");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i4_scheduled_searching_or_recent_albums_are_fine(pool: PgPool) {
    let ar = artist(&pool).await;
    let check = |grace| invariants::i4_missing_without_schedule(&pool, grace);
    // Расписание есть.
    let (scheduled, _) = album(&pool, ar, &[TrackStatus::NotFound]).await;
    acquisition::postpone(&pool, scheduled, HOUR).await.unwrap();
    // Идёт поиск: трек `adding`.
    album(&pool, ar, &[TrackStatus::NotFound, TrackStatus::Adding]).await;
    // Всё найдено.
    album(&pool, ar, &[TrackStatus::Found, TrackStatus::Ready]).await;
    assert!(check(ZERO).await.unwrap().is_none());

    // Нет расписания, но поиск активен (альбома или артиста).
    let (orphan, _) = album(&pool, ar, &[TrackStatus::NotFound]).await;
    assert_eq!(ids(&check(ZERO).await.unwrap()), vec![orphan]);
    assert!(check(HOUR).await.unwrap().is_none(), "в пределах отсрочки");
    for job in [
        Job::DiscoverAlbum { album_id: orphan },
        Job::DiscoverArtist { artist_id: ar },
    ] {
        sqlx::query("DELETE FROM jobs")
            .execute(&pool)
            .await
            .unwrap();
        enqueue(&pool, job).await;
        assert!(check(ZERO).await.unwrap().is_none());
    }

    // Отсрочка считается от конца последнего поиска, а не от изменения трека.
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    age(
        &pool,
        "UPDATE tracks SET updated_at = now() - interval '5 hours'",
    )
    .await;
    sqlx::query(
        "INSERT INTO album_search_state (album_id, last_finished_at) VALUES ($1, now())
         ON CONFLICT (album_id) DO UPDATE SET last_finished_at = now()",
    )
    .bind(orphan)
    .execute(&pool)
    .await
    .unwrap();
    assert!(check(HOUR).await.unwrap().is_none());
    assert_eq!(ids(&check(ZERO).await.unwrap()), vec![orphan]);
}

// ------------------------------------------------------------------ I5

async fn failed_job(pool: &PgPool, job: Job, fatal: bool) -> i64 {
    let id = enqueue(pool, job.clone()).await;
    // Не через `claim`: он взял бы любую ожидающую задачу того же вида.
    sqlx::query(
        "UPDATE jobs SET state = 'running', locked_by = 'w', locked_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    jobs::fail(pool, id, "w", "boom", None, fatal)
        .await
        .unwrap()
        .unwrap();
    id
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i5_failed_import_waiting_too_long_is_a_violation(pool: PgPool) {
    let id = failed_job(&pool, Job::ImportArtist { artist_id: 1 }, false).await;
    let other = failed_job(&pool, Job::DiscoverArtist { artist_id: 1 }, false).await;
    let check = |grace| invariants::i5_failed_not_revived(&pool, grace, HOUR * 24);
    assert!(check(ZERO).await.unwrap().is_none(), "ещё ждёт оживления");
    age(
        &pool,
        "UPDATE jobs SET updated_at = now() - interval '25 hours'",
    )
    .await;
    let s = check(ZERO).await.unwrap();
    assert_eq!(ids(&s), vec![id, other]);
    let s = s.unwrap();
    assert_eq!(s.violations[0].entity, "job");
    assert!(s.violations[0].detail.contains("import_artist:1"));
    assert!(
        check(HOUR * 2).await.unwrap().is_none(),
        "отсрочка сверх суток"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i5_ignores_fatal_superseded_and_other_kinds(pool: PgPool) {
    failed_job(&pool, Job::ImportArtist { artist_id: 1 }, true).await;
    failed_job(&pool, Job::DiscoverAlbum { album_id: 1 }, false).await;
    // Упавшую задачу заменила новая с тем же ключом.
    failed_job(&pool, Job::ImportArtist { artist_id: 2 }, false).await;
    enqueue(&pool, Job::ImportArtist { artist_id: 2 }).await;
    age(
        &pool,
        "UPDATE jobs SET updated_at = now() - interval '3 days'",
    )
    .await;
    assert!(invariants::i5_failed_not_revived(&pool, ZERO, HOUR * 24)
        .await
        .unwrap()
        .is_none());
}

// ------------------------------------------------------------------ I6

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i6_running_job_without_heartbeat_is_a_violation(pool: PgPool) {
    let id = enqueue(&pool, Job::DiscoverAlbum { album_id: 1 }).await;
    jobs::claim(&pool, "w-1", &["discover_album"])
        .await
        .unwrap()
        .unwrap();
    let stale = Duration::from_secs(90);
    let check = |grace| invariants::i6_running_without_heartbeat(&pool, grace, stale);
    assert!(check(ZERO).await.unwrap().is_none(), "heartbeat свежий");
    age(
        &pool,
        "UPDATE jobs SET heartbeat_at = now() - interval '10 minutes'",
    )
    .await;
    let s = check(ZERO).await.unwrap().unwrap();
    assert_eq!(s.violations[0].id, id);
    assert_eq!(s.violations[0].detail, "discover_album locked by w-1");
    assert!(check(HOUR).await.unwrap().is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i6_ignores_queued_and_finished_jobs(pool: PgPool) {
    enqueue(&pool, Job::DiscoverAlbum { album_id: 1 }).await;
    failed_job(&pool, Job::DiscoverAlbum { album_id: 2 }, true).await;
    age(
        &pool,
        "UPDATE jobs SET updated_at = now() - interval '1 day', locked_at = now() - interval '1 day'",
    )
    .await;
    assert!(
        invariants::i6_running_without_heartbeat(&pool, ZERO, Duration::from_secs(90))
            .await
            .unwrap()
            .is_none()
    );
}

// ------------------------------------------------------------------ I7

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i7_queued_job_of_a_kind_without_handler_is_a_violation(pool: PgPool) {
    let id = enqueue(&pool, Job::EvictCache).await;
    enqueue(&pool, Job::RetryMissing).await;
    let known = vec!["retry_missing".to_string()];
    let s = invariants::i7_queued_without_handler(&pool, ZERO, &known)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.count, s.violations[0].id), (1, id));
    assert_eq!(s.violations[0].detail, "no handler for kind evict_cache");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i7_known_kinds_future_jobs_and_grace_are_fine(pool: PgPool) {
    enqueue(&pool, Job::EvictCache).await;
    let all = Params::new(ZERO).known_kinds;
    let check = |grace, known: Vec<String>| {
        let pool = pool.clone();
        async move {
            invariants::i7_queued_without_handler(&pool, grace, &known)
                .await
                .unwrap()
        }
    };
    assert!(check(ZERO, all).await.is_none(), "обработчик есть");
    assert!(check(HOUR, vec![]).await.is_none(), "в пределах отсрочки");
    age(
        &pool,
        "UPDATE jobs SET run_after = now() + interval '1 hour'",
    )
    .await;
    assert!(check(ZERO, vec![]).await.is_none(), "ещё не пора");
}

// ------------------------------------------------------------------ I8–I10: закрепления

async fn pinned(pool: &PgPool, statuses: &[TrackStatus]) -> Vec<i64> {
    let ar = artist(pool).await;
    let (_, tracks) = album(pool, ar, statuses).await;
    pins::pin_tracks(pool, &tracks, true).await.unwrap();
    tracks
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i8_failed_pin_without_schedule_is_a_violation(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Found, TrackStatus::Found]).await;
    pins::fail(&pool, t[0], "storage: disk full", None, false)
        .await
        .unwrap();
    sqlx::query("UPDATE pinned_tracks SET state = 'failed', error = NULL WHERE track_id = $1")
        .bind(t[1])
        .execute(&pool)
        .await
        .unwrap();
    let s = invariants::i8_failed_pin_without_schedule(&pool)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ids(&Some(s.clone())), t);
    assert_eq!(s.violations[0].entity, "pin");
    assert_eq!(s.violations[0].detail, "storage: disk full");
    assert_eq!(s.violations[1].detail, "no error");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i8_scheduled_and_final_failures_are_fine(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Found; 6]).await;
    let later = chrono::Utc::now() + chrono::Duration::hours(1);
    pins::fail(&pool, t[0], "stalled", Some(later), true)
        .await
        .unwrap();
    for (i, final_error) in [
        "dead",
        "torrent not found",
        "invalid magnet: no hash",
        "file index 7 is out of range",
    ]
    .iter()
    .enumerate()
    {
        pins::fail(&pool, t[i + 1], final_error, None, false)
            .await
            .unwrap();
    }
    // t[5] остаётся `queued`.
    assert!(invariants::i8_failed_pin_without_schedule(&pool)
        .await
        .unwrap()
        .is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i9_downloading_pin_without_download_row_is_a_violation(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Found, TrackStatus::Found]).await;
    let tor = torrent(&pool).await;
    primary(&pool, t[0], tor, 0).await;
    for id in &t {
        pins::set_state(&pool, *id, PinState::Downloading, None)
            .await
            .unwrap();
    }
    let s = invariants::i9_downloading_without_row(&pool, ZERO)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ids(&Some(s.clone())), t);
    assert_eq!(
        s.violations[0].detail,
        format!("torrent_id={tor} file_index=0")
    );
    assert_eq!(s.violations[1].detail, "no primary source");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i9_downloading_pin_with_row_or_within_grace_is_fine(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Found, TrackStatus::Found]).await;
    let tor = torrent(&pool).await;
    primary(&pool, t[0], tor, 0).await;
    primary(&pool, t[1], tor, 1).await;
    pins::set_state(&pool, t[0], PinState::Downloading, None)
        .await
        .unwrap();
    assert!(invariants::i9_downloading_without_row(&pool, HOUR)
        .await
        .unwrap()
        .is_none());
    download(&pool, tor, 0, false).await;
    // t[1] в очереди: строки `downloads` у него ещё и не должно быть.
    assert!(invariants::i9_downloading_without_row(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i10_waiting_pin_of_a_found_track_is_a_violation(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Adding, TrackStatus::Adding]).await;
    let tor = torrent(&pool).await;
    primary(&pool, t[0], tor, 0).await;
    // `set_primary` возвращает в очередь только не-`waiting_source`: состояние остаётся.
    tracks::set_status(&pool, t[0], TrackStatus::Found, None)
        .await
        .unwrap();
    let s = invariants::i10_waiting_with_source(&pool, ZERO)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.count, s.violations[0].id), (1, t[0]));
    assert_eq!(s.violations[0].detail, "track is found");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i10_waiting_pin_without_source_or_within_grace_is_fine(pool: PgPool) {
    let t = pinned(&pool, &[TrackStatus::Adding, TrackStatus::NotFound]).await;
    assert!(invariants::i10_waiting_with_source(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
    let tor = torrent(&pool).await;
    primary(&pool, t[0], tor, 0).await;
    tracks::set_status(&pool, t[0], TrackStatus::Found, None)
        .await
        .unwrap();
    assert!(invariants::i10_waiting_with_source(&pool, HOUR)
        .await
        .unwrap()
        .is_none());
}

// ------------------------------------------------------------------ I11

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i11_found_track_of_a_completed_file_is_a_violation_and_gets_promoted(pool: PgPool) {
    let ar = artist(&pool).await;
    let (_, t) = album(&pool, ar, &[TrackStatus::Found, TrackStatus::Found]).await;
    let tor = torrent(&pool).await;
    primary(&pool, t[0], tor, 0).await;
    primary(&pool, t[1], tor, 1).await;
    download(&pool, tor, 0, true).await;
    download(&pool, tor, 1, false).await;
    assert!(invariants::i11_completed_but_found(&pool, HOUR)
        .await
        .unwrap()
        .is_none());
    let s = invariants::i11_completed_but_found(&pool, ZERO)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.count, s.violations[0].id), (1, t[0]));
    assert_eq!(s.violations[0].entity, "track");

    // Страховка обслуживания чинит именно это.
    let promoted = tracks::promote_found_with_completed_file(&pool)
        .await
        .unwrap();
    assert_eq!(
        promoted.iter().map(|t| t.id).collect::<Vec<_>>(),
        vec![t[0]]
    );
    assert_eq!(promoted[0].status, TrackStatus::Ready);
    assert!(invariants::i11_completed_but_found(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        tracks::get(&pool, t[1]).await.unwrap().unwrap().status,
        TrackStatus::Found,
        "недокачанный файл трек не трогает"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i11_non_primary_source_of_a_completed_file_is_fine(pool: PgPool) {
    let ar = artist(&pool).await;
    let (_, t) = album(&pool, ar, &[TrackStatus::Found]).await;
    let (done, other) = (torrent(&pool).await, torrent(&pool).await);
    primary(&pool, t[0], done, 0).await;
    primary(&pool, t[0], other, 0).await;
    download(&pool, done, 0, true).await;
    assert!(invariants::i11_completed_but_found(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
    assert!(tracks::promote_found_with_completed_file(&pool)
        .await
        .unwrap()
        .is_empty());
}

// ------------------------------------------------------------------ I12

async fn library_artist(pool: &PgPool) -> i64 {
    let id = artist(pool).await;
    artists::set_in_library(pool, id, true).await.unwrap();
    id
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i12_library_artist_without_albums_and_import_is_a_violation(pool: PgPool) {
    let id = library_artist(&pool).await;
    assert!(invariants::i12_artist_without_import(&pool, HOUR)
        .await
        .unwrap()
        .is_none());
    let s = invariants::i12_artist_without_import(&pool, ZERO)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.count, s.violations[0].id), (1, id));
    assert_eq!(s.violations[0].entity, "artist");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn i12_artist_with_albums_or_any_import_job_is_fine(pool: PgPool) {
    let with_album = library_artist(&pool).await;
    album(&pool, with_album, &[TrackStatus::Found]).await;
    let queued = library_artist(&pool).await;
    enqueue(&pool, Job::ImportArtist { artist_id: queued }).await;
    let failed = library_artist(&pool).await;
    failed_job(&pool, Job::ImportArtist { artist_id: failed }, true).await;
    // Не в библиотеке.
    artist(&pool).await;
    assert!(invariants::i12_artist_without_import(&pool, ZERO)
        .await
        .unwrap()
        .is_none());
}

// ------------------------------------------------------------------ check_all

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn check_all_is_clean_on_an_empty_and_a_healthy_database(pool: PgPool) {
    let p = Params::new(ZERO);
    assert!(invariants::check_all(&pool, &p).await.unwrap().is_clean());
    let ar = library_artist(&pool).await;
    let (a, t) = album(&pool, ar, &[TrackStatus::Ready, TrackStatus::NotFound]).await;
    acquisition::postpone(&pool, a, HOUR).await.unwrap();
    let tor = torrent(&pool).await;
    album_torrents::link(&pool, a, tor, "q", 0.5).await.unwrap();
    album_torrents::mark_verified(&pool, a, tor).await.unwrap();
    primary(&pool, t[0], tor, 0).await;
    download(&pool, tor, 0, true).await;
    pins::pin_tracks(&pool, &t, true).await.unwrap();
    let report = invariants::check_all(&pool, &p).await.unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert!(report.of("I1").is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn check_all_collects_sections_totals_and_caps_the_list(pool: PgPool) {
    // 60 артистов без импорта (I12) и один зависший альбом (I1 и I4 не пересекаются: он `adding`).
    for _ in 0..60 {
        library_artist(&pool).await;
    }
    let ar = artist(&pool).await;
    let (stuck, _) = album(&pool, ar, &[TrackStatus::Adding]).await;
    let (missing, _) = album(&pool, ar, &[TrackStatus::NotFound]).await;
    let report = invariants::check_all(&pool, &Params::new(ZERO))
        .await
        .unwrap();
    assert_eq!(report.total, 62);
    assert_eq!(report.grace_secs, 0);
    let codes: Vec<&str> = report.sections.iter().map(|s| s.invariant).collect();
    assert_eq!(codes, vec!["I1", "I4", "I12"]);
    assert_eq!(report.of("I1")[0].id, stuck);
    assert_eq!(report.of("I4")[0].id, missing);
    let i12 = report.sections.last().unwrap();
    assert_eq!(i12.count, 60);
    assert_eq!(i12.violations.len() as i64, invariants::MAX_VIOLATIONS);

    // Без авто-повтора I4 не проверяется: расписания некому исполнять.
    let mut p = Params::new(ZERO);
    p.auto_retry = false;
    let report = invariants::check_all(&pool, &p).await.unwrap();
    assert!(report.of("I4").is_empty());
    assert_eq!(report.total, 61);
}
