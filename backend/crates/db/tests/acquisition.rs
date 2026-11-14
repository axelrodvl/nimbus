// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::collections::HashMap;

use chrono::{Duration, Utc};
use nimbus_core::events::{Event, EventBus};
use nimbus_core::model::*;
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::acquisition::{self, Cursor};
use nimbus_db::repo::*;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

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

/// Альбом, трек `i` которого получает статус из `statuses[i]`; в библиотеке — все треки.
async fn album(pool: &PgPool, artist_id: i64, statuses: &[TrackStatus]) -> i64 {
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
        let reason = (*st == TrackStatus::NotFound).then_some(NotFoundReason::NoMatch);
        tracks::set_status(pool, t.id, *st, reason).await.unwrap();
    }
    albums::set_in_library(pool, a.id, true).await.unwrap();
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    a.id
}

/// Основной источник трека + строка `downloads` (скачивается или готова).
async fn attach_download(pool: &PgPool, track_id: i64, n: u8, completed: bool) {
    let hash = format!("{n:02x}").repeat(20);
    let t = torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: InfoHash::parse(&hash).unwrap(),
            magnet: format!("magnet:?xt=urn:btih:{hash}"),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "t".into(),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    track_sources::insert(
        pool,
        &NewTrackSource {
            track_id,
            torrent_id: t.id,
            file_index: 0,
            match_score: 1.0,
            needs_confirmation: false,
            cue_start_ms: None,
            cue_end_ms: None,
        },
    )
    .await
    .unwrap();
    track_sources::ensure_primaries(pool, &[track_id])
        .await
        .unwrap();
    downloads::upsert(
        pool,
        &NewDownload {
            torrent_id: t.id,
            file_index: 0,
            local_path: "/tmp/x".into(),
            bytes_total: 1000,
            bytes_done: 400,
        },
    )
    .await
    .unwrap();
    if completed {
        downloads::mark_completed(pool, t.id, 0).await.unwrap();
    }
}

async fn states(pool: &PgPool) -> HashMap<i64, AcquisitionState> {
    acquisition::list(pool, None, None, 200)
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|r| (r.album_id, r.state))
        .collect()
}

use TrackStatus::{Adding, Found, NotFound, Ready};

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn state_of_every_variant(pool: PgPool) {
    let ar = artist(&pool).await;
    let searching = album(&pool, ar, &[Adding, Found]).await;
    let searching2 = album(&pool, ar, &[Adding, NotFound, Ready]).await;
    let partial = album(&pool, ar, &[Found, NotFound]).await;
    let partial2 = album(&pool, ar, &[Ready, NotFound]).await;
    let missing = album(&pool, ar, &[NotFound, NotFound]).await;
    let available = album(&pool, ar, &[Found, Ready]).await;
    let available2 = album(&pool, ar, &[Found]).await;
    let downloaded = album(&pool, ar, &[Ready, Ready]).await;

    let s = states(&pool).await;
    assert_eq!(s[&searching], AcquisitionState::Searching);
    assert_eq!(s[&searching2], AcquisitionState::Searching);
    assert_eq!(s[&partial], AcquisitionState::Partial);
    assert_eq!(s[&partial2], AcquisitionState::Partial);
    assert_eq!(s[&missing], AcquisitionState::Missing);
    assert_eq!(s[&available], AcquisitionState::Available);
    assert_eq!(s[&available2], AcquisitionState::Available);
    assert_eq!(s[&downloaded], AcquisitionState::Downloaded);
    assert_eq!(s.len(), 8);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn active_download_beats_everything_but_searching(pool: PgPool) {
    let ar = artist(&pool).await;
    // Найден, файл качается → downloading.
    let found = album(&pool, ar, &[Found, Found]).await;
    let first = tracks::list_by_album(&pool, found).await.unwrap()[0].id;
    attach_download(&pool, first, 1, false).await;
    // Часть не найдена, но файл качается → downloading (приоритетнее partial).
    let partial = album(&pool, ar, &[Found, NotFound]).await;
    let first = tracks::list_by_album(&pool, partial).await.unwrap()[0].id;
    attach_download(&pool, first, 2, false).await;
    // Ищется и качается → searching.
    let searching = album(&pool, ar, &[Found, Adding]).await;
    let first = tracks::list_by_album(&pool, searching).await.unwrap()[0].id;
    attach_download(&pool, first, 3, false).await;
    // Загрузка завершена → обычное состояние.
    let done = album(&pool, ar, &[Found]).await;
    let first = tracks::list_by_album(&pool, done).await.unwrap()[0].id;
    attach_download(&pool, first, 4, true).await;

    let s = states(&pool).await;
    assert_eq!(s[&found], AcquisitionState::Downloading);
    assert_eq!(s[&partial], AcquisitionState::Downloading);
    assert_eq!(s[&searching], AcquisitionState::Searching);
    assert_eq!(s[&done], AcquisitionState::Available);

    let page = acquisition::list(&pool, Some(&[AcquisitionState::Downloading]), None, 10)
        .await
        .unwrap();
    let row = page.items.iter().find(|r| r.album_id == found).unwrap();
    assert_eq!((row.bytes_done, row.bytes_total), (Some(400), Some(1000)));
    let row = acquisition::list(&pool, Some(&[AcquisitionState::Available]), None, 10)
        .await
        .unwrap();
    assert_eq!(row.items[0].bytes_total, None, "нет активной загрузки");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn tracks_outside_library_are_ignored(pool: PgPool) {
    let ar = artist(&pool).await;
    // Трек вне библиотеки в статусе adding не делает альбом «ищущимся».
    let a = album(&pool, ar, &[Ready, Adding]).await;
    let outside = tracks::list_by_album(&pool, a).await.unwrap()[1].id;
    tracks::set_in_library(&pool, outside, false).await.unwrap();
    // Альбом, где в библиотеке нет ни одного трека, в списке отсутствует.
    let none = album(&pool, ar, &[NotFound]).await;
    tracks::set_in_library_for_album(&pool, none, false)
        .await
        .unwrap();

    let s = states(&pool).await;
    assert_eq!(s[&a], AcquisitionState::Downloaded);
    assert!(!s.contains_key(&none));
    let row = &acquisition::list(&pool, None, None, 10)
        .await
        .unwrap()
        .items[0];
    assert_eq!(row.total, 1, "считаются только треки библиотеки");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn reason_is_the_dominant_one_by_priority(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound, NotFound, NotFound, Found]).await;
    let ts = tracks::list_by_album(&pool, a).await.unwrap();
    for (t, reason) in ts.iter().zip([
        NotFoundReason::NoMatch,
        NotFoundReason::DeadTorrents,
        NotFoundReason::NoTorrents,
    ]) {
        tracks::set_status(&pool, t.id, NotFound, Some(reason))
            .await
            .unwrap();
    }
    let row = &acquisition::list(&pool, None, None, 10)
        .await
        .unwrap()
        .items[0];
    assert_eq!(row.reason.as_deref(), Some("no_torrents"));
    tracks::set_status(
        &pool,
        ts[2].id,
        NotFound,
        Some(NotFoundReason::SearchFailed),
    )
    .await
    .unwrap();
    let row = &acquisition::list(&pool, None, None, 10)
        .await
        .unwrap()
        .items[0];
    assert_eq!(row.reason.as_deref(), Some("search_failed"));
    // У найденных причины нет.
    let b = album(&pool, ar, &[Found]).await;
    let page = acquisition::list(&pool, Some(&[AcquisitionState::Available]), None, 10)
        .await
        .unwrap();
    assert_eq!(page.items[0].album_id, b);
    assert_eq!(page.items[0].reason, None);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn filter_order_and_cursor_pagination(pool: PgPool) {
    let ar = artist(&pool).await;
    let mut ids = vec![];
    for st in [
        vec![NotFound],        // missing, не искали
        vec![NotFound],        // missing, искали давно
        vec![NotFound],        // missing, искали недавно
        vec![Adding],          // searching
        vec![Found, NotFound], // partial, искали недавно (то же время, что и #2 — решает id)
        vec![Ready],           // downloaded, не искали
        vec![Adding],          // searching
    ] {
        ids.push(album(&pool, ar, &st).await);
    }
    let now = Utc::now();
    for (i, when) in [(1, now - Duration::days(3)), (2, now), (4, now)] {
        sqlx::query("INSERT INTO album_search_state (album_id, last_finished_at) VALUES ($1, $2)")
            .bind(ids[i])
            .bind(when)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Ожидаемый порядок: searching (по id), затем по last_finished_at DESC, без поиска — в конце по id.
    // Одинаковое время у ids[2] и ids[4] проверяет тай-брейк по id.
    sqlx::query("UPDATE album_search_state SET last_finished_at = (SELECT last_finished_at FROM album_search_state WHERE album_id = $1) WHERE album_id = $2")
        .bind(ids[2])
        .bind(ids[4])
        .execute(&pool)
        .await
        .unwrap();
    let expected = vec![ids[3], ids[6], ids[2], ids[4], ids[1], ids[0], ids[5]];
    let all: Vec<i64> = acquisition::list(&pool, None, None, 200)
        .await
        .unwrap()
        .items
        .iter()
        .map(|r| r.album_id)
        .collect();
    assert_eq!(all, expected);

    // Постранично по 2: ни дублей, ни пропусков, тот же порядок.
    for limit in [1, 2, 3, 7] {
        let mut seen = vec![];
        let mut cursor: Option<Cursor> = None;
        loop {
            let page = acquisition::list(&pool, None, cursor.as_ref(), limit)
                .await
                .unwrap();
            assert!(page.items.len() as i64 <= limit);
            seen.extend(page.items.iter().map(|r| r.album_id));
            // Курсор переживает кодирование для клиента.
            cursor = page
                .next
                .map(|c| Cursor::decode(&c.encode()).expect("roundtrip"));
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, expected, "limit {limit}");
    }

    // Фильтр: несколько состояний.
    let missing_partial = acquisition::list(
        &pool,
        Some(&[AcquisitionState::Missing, AcquisitionState::Partial]),
        None,
        200,
    )
    .await
    .unwrap();
    let got: Vec<i64> = missing_partial.items.iter().map(|r| r.album_id).collect();
    assert_eq!(got, vec![ids[2], ids[4], ids[1], ids[0]]);
    // Фильтр с курсором.
    let p1 = acquisition::list(&pool, Some(&[AcquisitionState::Searching]), None, 1)
        .await
        .unwrap();
    assert_eq!(p1.items[0].album_id, ids[3]);
    let p2 = acquisition::list(
        &pool,
        Some(&[AcquisitionState::Searching]),
        p1.next.as_ref(),
        1,
    )
    .await
    .unwrap();
    assert_eq!(p2.items[0].album_id, ids[6]);
    assert!(p2.next.is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn summary_matches_list_counts(pool: PgPool) {
    let ar = artist(&pool).await;
    for st in [
        vec![Adding],
        vec![NotFound],
        vec![NotFound],
        vec![Found, NotFound],
        vec![Found],
        vec![Found],
        vec![Found],
        vec![Ready],
        vec![Ready, Ready],
    ] {
        album(&pool, ar, &st).await;
    }
    let first = tracks::list_by_album(
        &pool,
        albums::list_by_artist(&pool, ar).await.unwrap()[6].id,
    )
    .await
    .unwrap()[0]
        .id;
    attach_download(&pool, first, 9, false).await;

    let s = acquisition::summary(&pool).await.unwrap();
    let list = acquisition::list(&pool, None, None, 200)
        .await
        .unwrap()
        .items;
    let count = |st| list.iter().filter(|r| r.state == st).count() as i64;
    assert_eq!(s.searching, count(AcquisitionState::Searching));
    assert_eq!(s.missing, count(AcquisitionState::Missing));
    assert_eq!(s.partial, count(AcquisitionState::Partial));
    assert_eq!(s.available, count(AcquisitionState::Available));
    assert_eq!(s.downloading, count(AcquisitionState::Downloading));
    assert_eq!(s.downloaded, count(AcquisitionState::Downloaded));
    assert_eq!(
        (
            s.searching,
            s.missing,
            s.partial,
            s.available,
            s.downloading,
            s.downloaded
        ),
        (1, 2, 1, 2, 1, 2)
    );
}

// ------------------------------------------------------------------ состояние поиска

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn finish_search_computes_outcome_from_tracks(pool: PgPool) {
    let ar = artist(&pool).await;
    let cases: [(Vec<TrackStatus>, SearchOutcome); 3] = [
        (vec![Found, Ready], SearchOutcome::Found),
        (vec![Found, NotFound], SearchOutcome::Partial),
        (vec![NotFound, NotFound], SearchOutcome::NoMatch),
    ];
    for (st, want) in cases {
        let a = album(&pool, ar, &st).await;
        acquisition::mark_search_started(&pool, a).await.unwrap();
        let got = acquisition::finish_search(&pool, a, None).await.unwrap();
        assert_eq!(got, Some(want), "{st:?}");
        let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
        assert_eq!((s.attempts, s.last_outcome), (1, Some(want)));
        assert!(s.last_finished_at.is_some());
        assert_eq!(
            s.next_retry_at.is_none(),
            want == SearchOutcome::Found,
            "найденный альбом повторять не нужно"
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn finish_search_reason_priority_and_fallback(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound, NotFound]).await;
    let ts = tracks::list_by_album(&pool, a).await.unwrap();
    tracks::set_status(
        &pool,
        ts[0].id,
        NotFound,
        Some(NotFoundReason::DeadTorrents),
    )
    .await
    .unwrap();
    tracks::set_status(&pool, ts[1].id, NotFound, Some(NotFoundReason::NoTorrents))
        .await
        .unwrap();
    acquisition::mark_search_started(&pool, a).await.unwrap();
    assert_eq!(
        acquisition::finish_search(&pool, a, Some(NotFoundReason::NoMatch))
            .await
            .unwrap(),
        Some(SearchOutcome::NoTorrents),
        "причина треков важнее запасной"
    );

    // Нет причины у треков — берём запасную.
    let b = album(&pool, ar, &[NotFound]).await;
    let t = tracks::list_by_album(&pool, b).await.unwrap()[0].id;
    sqlx::query("UPDATE tracks SET status_reason = NULL WHERE id = $1")
        .bind(t)
        .execute(&pool)
        .await
        .unwrap();
    acquisition::mark_search_started(&pool, b).await.unwrap();
    assert_eq!(
        acquisition::finish_search(&pool, b, Some(NotFoundReason::SearchFailed))
            .await
            .unwrap(),
        Some(SearchOutcome::SearchFailed)
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn finish_search_happens_once_per_search(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    assert_eq!(
        acquisition::finish_search(&pool, a, None).await.unwrap(),
        None,
        "поиска не было"
    );
    acquisition::mark_search_started(&pool, a).await.unwrap();
    assert!(acquisition::finish_search(&pool, a, None)
        .await
        .unwrap()
        .is_some());
    for _ in 0..3 {
        assert_eq!(
            acquisition::finish_search(&pool, a, None).await.unwrap(),
            None,
            "повторная финализация не считается"
        );
    }
    assert_eq!(
        acquisition::get_state(&pool, a)
            .await
            .unwrap()
            .unwrap()
            .attempts,
        1
    );
    // Новый поиск — новый учёт.
    acquisition::mark_search_started(&pool, a).await.unwrap();
    assert!(acquisition::finish_search(&pool, a, None)
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        acquisition::get_state(&pool, a)
            .await
            .unwrap()
            .unwrap()
            .attempts,
        2
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn backoff_grows_with_auto_retries(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    let hours = [(0, 6), (1, 24), (2, 72), (3, 168), (4, 720), (9, 720)];
    for (auto, want_hours) in hours {
        acquisition::mark_search_started(&pool, a).await.unwrap();
        sqlx::query("UPDATE album_search_state SET auto_retries = $2 WHERE album_id = $1")
            .bind(a)
            .bind(auto)
            .execute(&pool)
            .await
            .unwrap();
        acquisition::finish_search(&pool, a, None).await.unwrap();
        let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
        let wait = s.next_retry_at.unwrap() - s.last_finished_at.unwrap();
        assert_eq!(wait.num_hours(), want_hours, "auto_retries = {auto}");
        assert_eq!(
            s.auto_retries, auto,
            "авто-повторы не сбрасываются без успеха"
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn success_resets_auto_retries_and_schedule(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[Found]).await;
    acquisition::mark_search_started(&pool, a).await.unwrap();
    sqlx::query(
        "UPDATE album_search_state SET auto_retries = 3, next_retry_at = now() + interval '1 day' WHERE album_id = $1",
    )
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    acquisition::finish_search(&pool, a, None).await.unwrap();
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at), (0, None));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn search_results_are_stored_and_survive_started_and_finished(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    acquisition::mark_search_started(&pool, a).await.unwrap();
    let errors = json!([{"source": "tpb", "error": "blocked: down"}]);
    acquisition::record_search_results(&pool, a, 4, &errors)
        .await
        .unwrap();
    acquisition::finish_search(&pool, a, None).await.unwrap();
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!((s.candidates, s.provider_errors), (4, errors));
    let row = &acquisition::list(&pool, None, None, 10)
        .await
        .unwrap()
        .items[0];
    assert_eq!(row.candidates, 4);
    assert_eq!(row.provider_errors[0]["source"], "tpb");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn reset_auto_retries_clears_schedule(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    sqlx::query(
        "INSERT INTO album_search_state (album_id, auto_retries, next_retry_at, attempts) VALUES ($1, 4, now(), 7)",
    )
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    acquisition::reset_auto_retries(&pool, a).await.unwrap();
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at, s.attempts), (0, None, 7));
    // Для альбома без записи строка создаётся.
    let b = album(&pool, ar, &[NotFound]).await;
    acquisition::reset_auto_retries(&pool, b).await.unwrap();
    assert!(acquisition::get_state(&pool, b).await.unwrap().is_some());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn take_due_picks_only_due_missing_and_partial(pool: PgPool) {
    let ar = artist(&pool).await;
    let due_missing = album(&pool, ar, &[NotFound]).await;
    let due_partial = album(&pool, ar, &[Found, NotFound]).await;
    let not_due = album(&pool, ar, &[NotFound]).await;
    let due_found = album(&pool, ar, &[Found]).await;
    let due_searching = album(&pool, ar, &[Adding]).await;
    let no_row = album(&pool, ar, &[NotFound]).await;
    for (a, when) in [
        (due_missing, "now() - interval '2 hours'"),
        (due_partial, "now() - interval '1 hour'"),
        (not_due, "now() + interval '1 hour'"),
        (due_found, "now() - interval '1 hour'"),
        (due_searching, "now() - interval '1 hour'"),
    ] {
        sqlx::query(&format!(
            "INSERT INTO album_search_state (album_id, next_retry_at, auto_retries) VALUES ($1, {when}, 1)"
        ))
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    }

    let mut conn = pool.acquire().await.unwrap();
    let ids = acquisition::take_due(&mut conn, 50).await.unwrap();
    assert_eq!(
        ids,
        vec![due_missing, due_partial],
        "по возрастанию next_retry_at"
    );
    drop(conn);

    let get = |a| {
        let pool = pool.clone();
        async move { acquisition::get_state(&pool, a).await.unwrap().unwrap() }
    };
    for a in [due_missing, due_partial] {
        let s = get(a).await;
        assert_eq!((s.auto_retries, s.next_retry_at), (2, None));
    }
    assert!(get(not_due).await.next_retry_at.is_some(), "ещё не пора");
    // Просрочка у уже найденного/ищущегося сброшена, счётчик не тронут.
    for a in [due_found, due_searching] {
        let s = get(a).await;
        assert_eq!((s.auto_retries, s.next_retry_at), (1, None));
    }
    assert!(acquisition::get_state(&pool, no_row)
        .await
        .unwrap()
        .is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn take_due_respects_limit_and_does_not_overlap(pool: PgPool) {
    let ar = artist(&pool).await;
    let mut all = vec![];
    for i in 0..5 {
        let a = album(&pool, ar, &[NotFound]).await;
        sqlx::query(
            "INSERT INTO album_search_state (album_id, next_retry_at) VALUES ($1, now() - ($2 || ' minutes')::interval)",
        )
        .bind(a)
        .bind((10 - i).to_string())
        .execute(&pool)
        .await
        .unwrap();
        all.push(a);
    }
    // Две параллельные транзакции делят очередь без пересечений.
    let mut tx1 = pool.begin().await.unwrap();
    let first = acquisition::take_due(&mut tx1, 2).await.unwrap();
    let mut tx2 = pool.begin().await.unwrap();
    let second = acquisition::take_due(&mut tx2, 10).await.unwrap();
    tx1.commit().await.unwrap();
    tx2.commit().await.unwrap();
    assert_eq!(first, all[..2]);
    assert_eq!(second, all[2..]);
    let mut conn = pool.acquire().await.unwrap();
    assert!(acquisition::take_due(&mut conn, 10)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn take_due_rolls_back_with_the_transaction(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    sqlx::query("INSERT INTO album_search_state (album_id, next_retry_at) VALUES ($1, now())")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(acquisition::take_due(&mut tx, 10).await.unwrap(), vec![a]);
    tx.rollback().await.unwrap();
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!(s.auto_retries, 0);
    assert!(s.next_retry_at.is_some(), "откат не теряет альбом");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn schedule_missing_now_touches_only_missing_and_partial(pool: PgPool) {
    let ar = artist(&pool).await;
    let missing = album(&pool, ar, &[NotFound]).await;
    let partial = album(&pool, ar, &[Found, NotFound]).await;
    let found = album(&pool, ar, &[Found]).await;
    let searching = album(&pool, ar, &[Adding]).await;
    sqlx::query("INSERT INTO album_search_state (album_id, next_retry_at, attempts) VALUES ($1, now() + interval '30 days', 3)")
        .bind(missing)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(acquisition::schedule_missing_now(&pool).await.unwrap(), 2);
    for a in [missing, partial] {
        let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
        assert!(
            s.next_retry_at.unwrap() <= Utc::now(),
            "авто-повтор «сейчас»"
        );
    }
    assert_eq!(
        acquisition::get_state(&pool, missing)
            .await
            .unwrap()
            .unwrap()
            .attempts,
        3,
        "история поиска сохранена"
    );
    for a in [found, searching] {
        assert!(acquisition::get_state(&pool, a).await.unwrap().is_none());
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn ids_in_states_and_existing_albums(pool: PgPool) {
    let ar = artist(&pool).await;
    let m = album(&pool, ar, &[NotFound]).await;
    let p = album(&pool, ar, &[Found, NotFound]).await;
    let _f = album(&pool, ar, &[Found]).await;
    let both = [AcquisitionState::Missing, AcquisitionState::Partial];
    assert_eq!(
        acquisition::ids_in_states(&pool, &both, 10).await.unwrap(),
        vec![m, p]
    );
    assert_eq!(
        acquisition::ids_in_states(&pool, &both, 1).await.unwrap(),
        vec![m]
    );
    assert_eq!(
        acquisition::existing_albums(&pool, &[p, 99_999, m])
            .await
            .unwrap(),
        vec![m, p]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn active_jobs_count_only_album_search_jobs(pool: PgPool) {
    use nimbus_core::jobs::Job;
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[Adding]).await;
    let other = album(&pool, ar, &[Adding]).await;
    for job in [
        Job::DiscoverAlbum { album_id: a },
        Job::VerifyTorrent {
            torrent_id: 1,
            album_id: a,
        },
        Job::VerifyTorrent {
            torrent_id: 2,
            album_id: a,
        },
        Job::DiscoverAlbum { album_id: other },
        Job::DiscoverArtist { artist_id: ar },
    ] {
        jobs::enqueue(&pool, &job, jobs::EnqueueOpts::default())
            .await
            .unwrap();
    }
    let rows = acquisition::list(&pool, None, None, 10)
        .await
        .unwrap()
        .items;
    let n = |id| rows.iter().find(|r| r.album_id == id).unwrap().active_jobs;
    assert_eq!((n(a), n(other)), (3, 1));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn reset_dead_returns_dead_torrents_to_pending(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[NotFound]).await;
    let mut ids = vec![];
    for (n, st) in [
        (1u8, MetaStatus::Dead),
        (2, MetaStatus::Timeout),
        (3, MetaStatus::Error),
        (4, MetaStatus::Ok),
    ] {
        let hash = format!("{n:02x}").repeat(20);
        let t = torrents::upsert_by_info_hash(
            &pool,
            &NewTorrent {
                info_hash: InfoHash::parse(&hash).unwrap(),
                magnet: format!("magnet:?xt=urn:btih:{hash}"),
                source: TorrentSource::Tpb,
                source_topic_id: None,
                title: "t".into(),
                size_bytes: None,
                seeders: None,
                leechers: None,
                kind: TorrentKind::Album,
            },
        )
        .await
        .unwrap();
        torrents::set_meta_status(&pool, t.id, MetaStatus::Fetching, None)
            .await
            .unwrap();
        torrents::set_meta_status(&pool, t.id, st, Some("boom"))
            .await
            .unwrap();
        album_torrents::link(&pool, a, t.id, "q", 0.5)
            .await
            .unwrap();
        album_torrents::mark_verified(&pool, a, t.id).await.unwrap();
        ids.push(t.id);
    }
    assert_eq!(album_torrents::reset_dead(&pool, a).await.unwrap(), 3);
    for id in &ids[..3] {
        let t = torrents::get(&pool, *id).await.unwrap().unwrap();
        assert_eq!(
            (t.meta_status, t.meta_attempts, t.meta_error),
            (MetaStatus::Pending, 0, None)
        );
    }
    assert_eq!(album_torrents::count_unverified(&pool, a).await.unwrap(), 3);
    let ok = torrents::get(&pool, ids[3]).await.unwrap().unwrap();
    assert_eq!(ok.meta_status, MetaStatus::Ok, "рабочая раздача не тронута");
}

// ------------------------------------------------------------------ события

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_status_change_publishes_acquisition_changed(pool: PgPool) {
    let ar = artist(&pool).await;
    let a = album(&pool, ar, &[Adding]).await;
    let t = tracks::list_by_album(&pool, a).await.unwrap()[0].id;
    let events = EventBus::new();
    let mut rx = events.subscribe();
    set_track_status_and_publish(&pool, &events, t, Found, None)
        .await
        .unwrap();
    let mut got = vec![];
    while let Ok(e) = rx.try_recv() {
        got.push(e);
    }
    assert!(got
        .iter()
        .any(|e| matches!(e, Event::TrackStatus { track_id, .. } if *track_id == t)));
    assert!(got.contains(&Event::AcquisitionChanged { album_id: a }));
}
