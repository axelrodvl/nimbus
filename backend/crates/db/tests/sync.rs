// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use futures::StreamExt;
use nimbus_db::repo::sync::{self, Entity, SyncCursor};
use sqlx::PgPool;

async fn one(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn exec(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

/// Артист 1, альбом 1, трек 1 (и по 2 трека/источника там, где нужно — тестами).
async fn seed(pool: &PgPool) {
    exec(
        pool,
        "INSERT INTO artists (id, mbid, name) VALUES (1, gen_random_uuid(), 'A')",
    )
    .await;
    exec(pool, "INSERT INTO albums (id, mbid_release_group, artist_id, title) VALUES (1, gen_random_uuid(), 1, 'Al')").await;
    exec(pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (1, gen_random_uuid(), 1, 1, 'T1', 1), (2, gen_random_uuid(), 1, 1, 'T2', 2)").await;
    // последовательности не знают о явных id
    for t in [
        "artists",
        "albums",
        "tracks",
        "playlists",
        "playlist_tracks",
        "track_sources",
    ] {
        exec(
            pool,
            &format!("SELECT setval(pg_get_serial_sequence('{t}', 'id'), 1000)"),
        )
        .await;
    }
}

async fn txid(pool: &PgPool, table: &str, id: i64) -> i64 {
    one(
        pool,
        &format!("SELECT sync_txid FROM {table} WHERE id = {id}"),
    )
    .await
}

/// Курсор «сейчас» для тестов: `xmax`, а не `xmin`. Номера транзакций общие на весь кластер
/// Postgres, и открытая транзакция соседнего теста (другая БД) занижает `xmin` — сервер в таком
/// случае корректно присылает лишнее, но тесту нужна точная граница своих записей.
async fn cursor_now(pool: &PgPool) -> SyncCursor {
    let (tx, snap) = sync::begin_snapshot(pool).await.unwrap();
    tx.rollback().await.unwrap();
    SyncCursor {
        base: snap.xmax,
        after: None,
    }
}

async fn changes(pool: &PgPool, c: &SyncCursor) -> sync::Changes {
    let (mut tx, _) = sync::begin_snapshot(pool).await.unwrap();
    let out = sync::changes_since(&mut tx, c, 5000).await.unwrap();
    tx.rollback().await.unwrap();
    out
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn insert_and_update_of_each_entity_stamp_a_new_txid(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
    exec(
        &pool,
        "INSERT INTO playlist_tracks (id, playlist_id, track_id) VALUES (1, 1, 1)",
    )
    .await;
    let cases = [
        ("artists", "UPDATE artists SET name = 'B' WHERE id = 1"),
        ("albums", "UPDATE albums SET title = 'B' WHERE id = 1"),
        ("tracks", "UPDATE tracks SET title = 'B' WHERE id = 1"),
        ("playlists", "UPDATE playlists SET name = 'B' WHERE id = 1"),
        (
            "playlist_tracks",
            "UPDATE playlist_tracks SET added_at = now() WHERE id = 1",
        ),
    ];
    for (table, update) in cases {
        let inserted = txid(&pool, table, 1).await;
        assert!(inserted > 0, "{table}: INSERT ставит txid");
        exec(&pool, update).await;
        assert!(
            txid(&pool, table, 1).await > inserted,
            "{table}: UPDATE ставит новый txid"
        );
        // UPDATE, ничего не менявший, тоже «касается» строки.
        let before = txid(&pool, table, 1).await;
        exec(&pool, update).await;
        assert!(
            txid(&pool, table, 1).await > before,
            "{table}: пустой UPDATE"
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn delete_makes_tombstone_and_recreation_with_same_id_is_fine(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
    exec(
        &pool,
        "INSERT INTO playlist_tracks (id, playlist_id, track_id) VALUES (1, 1, 1)",
    )
    .await;
    for _round in 0..2 {
        exec(&pool, "DELETE FROM playlist_tracks WHERE id = 1").await;
        exec(&pool, "DELETE FROM playlists WHERE id = 1").await;
        exec(&pool, "DELETE FROM tracks WHERE id = 2").await;
        let n = one(&pool, "SELECT count(*) FROM sync_tombstones").await;
        assert_eq!(n, 3);
        // повторное создание с тем же id и повторное удаление не падают (ON CONFLICT DO UPDATE)
        exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
        exec(
            &pool,
            "INSERT INTO playlist_tracks (id, playlist_id, track_id) VALUES (1, 1, 1)",
        )
        .await;
        exec(&pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (2, gen_random_uuid(), 1, 1, 'T2', 2)").await;
    }
    exec(&pool, "DELETE FROM artists WHERE id = 1").await;
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT entity, entity_id FROM sync_tombstones ORDER BY entity, entity_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    // каскад: артист → альбом → оба трека (и плейлист-трек, ссылавшийся на трек 1)
    for expected in [
        ("artist", 1),
        ("album", 1),
        ("track", 1),
        ("track", 2),
        ("playlist_track", 1),
    ] {
        assert!(
            rows.contains(&(expected.0.to_string(), expected.1)),
            "нет надгробия {expected:?}: {rows:?}"
        );
    }
}

async fn add_source(pool: &PgPool, id: i64, track_id: i64, primary: bool) {
    exec(pool, "INSERT INTO torrents (id, info_hash, magnet, source, title) VALUES (1, repeat('a', 40), 'm', 'tpb', 't') ON CONFLICT DO NOTHING").await;
    exec(pool, &format!("INSERT INTO track_sources (id, track_id, torrent_id, file_index, match_score, is_primary) VALUES ({id}, {track_id}, 1, {id}, 1.0, {primary})")).await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_sources_changes_touch_only_their_tracks(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (3, gen_random_uuid(), 1, 1, 'T3', 3)").await;

    // вставка источника трека 1: трек 1 тронут, 2 и 3 — нет
    let (t2, t3) = (
        txid(&pool, "tracks", 2).await,
        txid(&pool, "tracks", 3).await,
    );
    let t1 = txid(&pool, "tracks", 1).await;
    add_source(&pool, 1, 1, false).await;
    assert!(txid(&pool, "tracks", 1).await > t1);
    assert_eq!(txid(&pool, "tracks", 2).await, t2);
    assert_eq!(txid(&pool, "tracks", 3).await, t3);

    // смена primary (UPDATE): трек 1 снова тронут, остальные — нет
    let t1 = txid(&pool, "tracks", 1).await;
    exec(
        &pool,
        "UPDATE track_sources SET is_primary = TRUE WHERE id = 1",
    )
    .await;
    assert!(txid(&pool, "tracks", 1).await > t1);
    assert_eq!(txid(&pool, "tracks", 2).await, t2);

    // массовая вставка источников двух треков одним оператором — оба тронуты, третий нет
    exec(&pool, "INSERT INTO track_sources (track_id, torrent_id, file_index, match_score) VALUES (2, 1, 20, 1.0), (2, 1, 21, 1.0)").await;
    assert!(txid(&pool, "tracks", 2).await > t2);
    assert_eq!(txid(&pool, "tracks", 3).await, t3);

    // удаление источника
    let t1 = txid(&pool, "tracks", 1).await;
    exec(&pool, "DELETE FROM track_sources WHERE id = 1").await;
    assert!(txid(&pool, "tracks", 1).await > t1);
    assert_eq!(txid(&pool, "tracks", 3).await, t3);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn track_plays_changes_touch_only_their_tracks(pool: PgPool) {
    seed(&pool).await;
    let t2 = txid(&pool, "tracks", 2).await;
    let t1 = txid(&pool, "tracks", 1).await;
    exec(
        &pool,
        "INSERT INTO track_plays (track_id, play_count, last_played_at) VALUES (1, 1, now())",
    )
    .await;
    let t1_ins = txid(&pool, "tracks", 1).await;
    assert!(t1_ins > t1);
    // upsert (ON CONFLICT DO UPDATE) — как в record_play
    exec(&pool, "INSERT INTO track_plays (track_id, play_count) VALUES (1, 1) ON CONFLICT (track_id) DO UPDATE SET play_count = track_plays.play_count + 1").await;
    assert!(txid(&pool, "tracks", 1).await > t1_ins);
    exec(&pool, "DELETE FROM track_plays WHERE track_id = 1").await;
    assert_eq!(txid(&pool, "tracks", 2).await, t2, "чужой трек не тронут");
    // изменение счётчика видно в дельте
    let c = cursor_now(&pool).await;
    exec(
        &pool,
        "INSERT INTO track_plays (track_id, play_count) VALUES (2, 5)",
    )
    .await;
    let ch = changes(&pool, &c).await;
    assert_eq!(
        ch.tracks
            .iter()
            .map(|t| (t.id, t.play_count))
            .collect::<Vec<_>>(),
        vec![(2, 5)]
    );
}

/// Гонка, ради которой всё затевалось: транзакция A изменила трек, но не закоммичена;
/// дельта выдаёт курсор C1; A коммитится — дельта от C1 обязана содержать изменение A.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn uncommitted_writer_is_not_lost_by_the_cursor(pool: PgPool) {
    seed(&pool).await;
    let mut a = pool.begin().await.unwrap();
    sqlx::query("UPDATE tracks SET title = 'changed by A' WHERE id = 1")
        .execute(&mut *a)
        .await
        .unwrap();

    // Параллельно закоммиченная запись с бо́льшим txid — курсор не должен «перепрыгнуть» через A.
    exec(
        &pool,
        "UPDATE tracks SET title = 'changed by B' WHERE id = 2",
    )
    .await;

    let (mut tx, snap) = sync::begin_snapshot(&pool).await.unwrap();
    let first = sync::changes_since(
        &mut tx,
        &SyncCursor {
            base: 0,
            after: None,
        },
        5000,
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert!(
        first.tracks.iter().any(|t| t.id == 2)
            && first.tracks.iter().all(|t| t.title != "changed by A"),
        "A не закоммичена и не видна"
    );
    let c1 = SyncCursor {
        base: snap.xmin,
        after: None,
    };

    a.commit().await.unwrap();
    let second = changes(&pool, &c1).await;
    assert!(
        second
            .tracks
            .iter()
            .any(|t| t.id == 1 && t.title == "changed by A"),
        "изменение A должно прийти в дельте от C1"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changes_exclude_tombstone_of_recreated_row_and_order_by_position(pool: PgPool) {
    seed(&pool).await;
    let c = cursor_now(&pool).await;
    exec(&pool, "DELETE FROM tracks WHERE id = 2").await;
    exec(&pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (2, gen_random_uuid(), 1, 1, 'T2 again', 2)").await;
    exec(&pool, "DELETE FROM tracks WHERE id = 1").await;
    let ch = changes(&pool, &c).await;
    assert_eq!(ch.tracks.iter().map(|t| t.id).collect::<Vec<_>>(), vec![2]);
    assert_eq!(
        ch.deleted,
        vec![(Entity::Track, 1)],
        "надгробие трека 2 скрыто: строка жива"
    );
    assert!(!ch.more);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn continuation_cursor_pages_through_rows_of_one_transaction(pool: PgPool) {
    seed(&pool).await;
    let c = cursor_now(&pool).await;
    // 25 треков одним оператором — один txid на всех
    exec(
        &pool,
        "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position)
                 SELECT gen_random_uuid(), 1, 1, 't', 100 + g FROM generate_series(1, 25) g",
    )
    .await;
    let mut seen = std::collections::BTreeSet::new();
    let mut cur = c;
    let mut pages = 0;
    loop {
        let (mut tx, _) = sync::begin_snapshot(&pool).await.unwrap();
        let ch = sync::changes_since(&mut tx, &cur, 10).await.unwrap();
        tx.rollback().await.unwrap();
        seen.extend(ch.tracks.iter().map(|t| t.id));
        pages += 1;
        assert!(pages < 10, "курсор не продвигается");
        if !ch.more {
            break;
        }
        cur = SyncCursor {
            base: c.base,
            after: ch.last,
        };
    }
    assert_eq!(pages, 3);
    assert_eq!(seen.len(), 25);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn snapshot_streams_all_rows_in_one_consistent_view(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
    let (mut tx, _) = sync::begin_snapshot(&pool).await.unwrap();
    let mut tracks = sync::tracks(&mut tx);
    let mut n = 0;
    while let Some(r) = tracks.next().await {
        r.unwrap();
        n += 1;
    }
    drop(tracks);
    assert_eq!(n, 2);
    // запись после снимка в чтение не попадает
    exec(&pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (9, gen_random_uuid(), 1, 1, 'late', 9)").await;
    let mut tracks = sync::tracks(&mut tx);
    let mut n = 0;
    while tracks.next().await.is_some() {
        n += 1;
    }
    assert_eq!(n, 2);
    drop(tracks);
    assert_eq!(sync::artists(&mut tx).count().await, 1);
    assert_eq!(sync::albums(&mut tx).count().await, 1);
    assert_eq!(sync::playlists(&mut tx).count().await, 1);
    assert_eq!(sync::playlist_tracks(&mut tx).count().await, 0);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn meta_has_epoch_and_zero_floor(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    let m = sync::meta(&mut conn).await.unwrap();
    assert_eq!(m.floor, 0);
    assert_eq!(m.epoch.len(), 36, "uuid");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn purge_removes_only_old_tombstones_and_raises_floor(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "DELETE FROM tracks WHERE id = 1").await; // старое
    exec(
        &pool,
        "UPDATE sync_tombstones SET deleted_at = now() - interval '40 days'",
    )
    .await;
    let old_txid = one(&pool, "SELECT sync_txid FROM sync_tombstones").await;
    exec(&pool, "DELETE FROM tracks WHERE id = 2").await; // свежее

    // нечего чистить при длинном сроке
    assert_eq!(
        sync::purge_tombstones(&pool, std::time::Duration::from_secs(90 * 86400))
            .await
            .unwrap(),
        0
    );
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(sync::meta(&mut conn).await.unwrap().floor, 0);
    drop(conn);

    let n = sync::purge_tombstones(&pool, sync::TOMBSTONE_RETENTION)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let left: Vec<i64> = sqlx::query_scalar("SELECT entity_id FROM sync_tombstones")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(left, vec![2]);
    let mut conn = pool.acquire().await.unwrap();
    let floor = sync::meta(&mut conn).await.unwrap().floor;
    assert_eq!(floor, old_txid + 1);

    // floor не уменьшается, повторная чистка без старых надгробий ничего не меняет
    assert_eq!(
        sync::purge_tombstones(&pool, sync::TOMBSTONE_RETENTION)
            .await
            .unwrap(),
        0
    );
    assert_eq!(sync::meta(&mut conn).await.unwrap().floor, floor);
}

// ---- закрепления в синхронизации (ревью S11)

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_album_bumps_tracks_in_delta(pool: PgPool) {
    seed(&pool).await;
    exec(
        &pool,
        "UPDATE tracks SET in_library = TRUE, status = 'found'",
    )
    .await;
    let c = cursor_now(&pool).await;
    let mut conn = pool.acquire().await.unwrap();
    nimbus_db::repo::pins::pin_album(&mut conn, 1)
        .await
        .unwrap();
    let ch = changes(&pool, &c).await;
    let mut got: Vec<_> = ch
        .tracks
        .iter()
        .map(|t| (t.id, t.pin.map(|p| p.to_string()), t.pin_error.clone()))
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            (1, Some("queued".into()), None),
            (2, Some("queued".into()), None)
        ]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_state_change_bumps_track(pool: PgPool) {
    seed(&pool).await;
    exec(
        &pool,
        "INSERT INTO pinned_tracks (track_id, state) VALUES (1, 'queued')",
    )
    .await;
    let t2 = txid(&pool, "tracks", 2).await;
    let c = cursor_now(&pool).await;
    exec(
        &pool,
        "UPDATE pinned_tracks SET state = 'failed', error = 'stalled' WHERE track_id = 1",
    )
    .await;
    let ch = changes(&pool, &c).await;
    assert_eq!(ch.tracks.len(), 1);
    assert_eq!(ch.tracks[0].id, 1);
    assert_eq!(
        ch.tracks[0].pin.map(|p| p.to_string()).as_deref(),
        Some("failed")
    );
    assert_eq!(ch.tracks[0].pin_error.as_deref(), Some("stalled"));
    assert_eq!(txid(&pool, "tracks", 2).await, t2, "чужой трек не тронут");
    // смена только ошибки — тоже видна клиенту
    let c = cursor_now(&pool).await;
    exec(
        &pool,
        "UPDATE pinned_tracks SET error = 'dead' WHERE track_id = 1",
    )
    .await;
    assert_eq!(changes(&pool, &c).await.tracks.len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_retries_only_update_no_delta(pool: PgPool) {
    seed(&pool).await;
    exec(
        &pool,
        "INSERT INTO pinned_tracks (track_id, state, error) VALUES (1, 'failed', 'stalled')",
    )
    .await;
    let c = cursor_now(&pool).await;
    nimbus_db::repo::pins::set_retries(&pool, 1, 3)
        .await
        .unwrap();
    nimbus_db::repo::pins::reset_retries(&pool, 1)
        .await
        .unwrap();
    exec(
        &pool,
        "UPDATE pinned_tracks SET next_retry_at = now() + interval '1 hour', updated_at = now()",
    )
    .await;
    // повторное закрепление уже закреплённого (не failed) трека меняет только служебные поля
    exec(
        &pool,
        "UPDATE pinned_tracks SET state = 'queued', error = NULL",
    )
    .await;
    let c2 = cursor_now(&pool).await;
    nimbus_db::repo::pins::pin_tracks(&pool, &[1], true)
        .await
        .unwrap();
    let ch = changes(&pool, &c2).await;
    assert!(
        ch.tracks.is_empty(),
        "служебные поля дельты не дают: {:?}",
        ch.tracks
    );
    // а до c2 была одна видимая смена (failed → queued)
    assert_eq!(changes(&pool, &c).await.tracks.len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unpin_bumps_track_with_null_pin(pool: PgPool) {
    seed(&pool).await;
    exec(
        &pool,
        "INSERT INTO pinned_tracks (track_id, state) VALUES (1, 'done'), (2, 'done')",
    )
    .await;
    let c = cursor_now(&pool).await;
    nimbus_db::repo::pins::unpin_track(&pool, 1).await.unwrap();
    let ch = changes(&pool, &c).await;
    assert_eq!(ch.tracks.len(), 1);
    assert_eq!((ch.tracks[0].id, ch.tracks[0].pin), (1, None));
    // удаление трека каскадом снимает закрепление без ошибок, трек уходит надгробием
    let c = cursor_now(&pool).await;
    exec(&pool, "DELETE FROM tracks WHERE id = 2").await;
    let ch = changes(&pool, &c).await;
    assert!(ch.tracks.is_empty());
    assert_eq!(ch.deleted, vec![(Entity::Track, 2)]);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn snapshot_has_pin_fields(pool: PgPool) {
    seed(&pool).await;
    exec(
        &pool,
        "INSERT INTO pinned_tracks (track_id, state, error) VALUES (2, 'failed', 'stalled')",
    )
    .await;
    let (mut tx, _) = sync::begin_snapshot(&pool).await.unwrap();
    let mut rows: Vec<_> = sync::tracks(&mut tx)
        .map(|r| {
            let r = r.unwrap();
            (r.id, r.pin.map(|p| p.to_string()), r.pin_error)
        })
        .collect()
        .await;
    rows.sort();
    assert_eq!(
        rows,
        vec![
            (1, None, None),
            (2, Some("failed".into()), Some("stalled".into()))
        ]
    );
}

/// Порядок блокировок «трек → закрепление» (ревью S11): транзакция, державшая трек (как verify), затем меняет
/// закрепление; одновременно одиночный `set_state` того же трека. Если бы `set_state` сначала взял строку
/// закрепления, а триггер потом ждал трек, Postgres прервал бы одну из транзакций (deadlock).
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn pin_update_and_track_holder_do_not_deadlock(pool: PgPool) {
    use std::time::Duration;
    seed(&pool).await;
    exec(
        &pool,
        "INSERT INTO pinned_tracks (track_id, state, error) VALUES (1, 'failed', 'stalled')",
    )
    .await;

    let mut holder = pool.begin().await.unwrap();
    sqlx::query("UPDATE tracks SET title = 'T1*' WHERE id = 1")
        .execute(&mut *holder)
        .await
        .unwrap();

    let p = pool.clone();
    let waiter = tokio::spawn(async move {
        nimbus_db::repo::pins::set_state(&p, 1, nimbus_core::model::PinState::Downloading, None)
            .await
    });
    // `set_state` ждёт блокировку (трека — после исправления; до него — уже держа строку закрепления).
    nimbus_testkit::eventually(Duration::from_secs(10), || async {
        one(
            &pool,
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
        )
        .await
            == 1
    })
    .await;

    // verify: в той же транзакции возвращает закрепление в очередь
    nimbus_db::repo::pins::requeue_stalled_for_tracks(&mut *holder, &[1])
        .await
        .unwrap();
    holder.commit().await.unwrap();
    waiter.await.unwrap().unwrap();
    assert_eq!(
        one(
            &pool,
            "SELECT count(*) FROM pinned_tracks WHERE track_id = 1 AND state = 'downloading'"
        )
        .await,
        1
    );
}
