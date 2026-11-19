// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::collections::BTreeSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use axum::response::Response;
use common::{router, state};
use http_body_util::BodyExt;
use nimbus_api::sync::{spawn_sync_poker, spawn_sync_poker_with};
use nimbus_api::AppState;
use nimbus_core::events::Event;
use nimbus_core::Config;
use nimbus_testkit::eventually;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

async fn exec(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

/// Артист 1, альбом 1, треки 1 и 2. Счётчики id сдвинуты, чтобы вставки по умолчанию не конфликтовали.
async fn seed(pool: &PgPool) {
    exec(
        pool,
        "INSERT INTO artists (id, mbid, name) VALUES (1, gen_random_uuid(), 'A')",
    )
    .await;
    exec(pool, "INSERT INTO albums (id, mbid_release_group, artist_id, title) VALUES (1, gen_random_uuid(), 1, 'Al')").await;
    exec(pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (1, gen_random_uuid(), 1, 1, 'T1', 1), (2, gen_random_uuid(), 1, 1, 'T2', 2)").await;
    for t in [
        "artists",
        "albums",
        "tracks",
        "playlists",
        "playlist_tracks",
    ] {
        exec(
            pool,
            &format!("SELECT setval(pg_get_serial_sequence('{t}', 'id'), 1000)"),
        )
        .await;
    }
}

async fn send(app: &axum::Router, uri: &str, headers: &[(&str, &str)]) -> Response {
    let mut req = Request::get(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    app.clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn json_of(res: Response) -> (u16, Value) {
    let status = res.status().as_u16();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn changes(app: &axum::Router, cursor: &str) -> Value {
    let (status, v) =
        json_of(send(app, &format!("/api/sync/changes?cursor={cursor}"), &[]).await).await;
    assert_eq!(status, 200, "{v}");
    v
}

fn ids(v: &Value, key: &str) -> Vec<i64> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

fn is_empty_delta(v: &Value) -> bool {
    [
        "artists",
        "albums",
        "tracks",
        "playlists",
        "playlist_tracks",
        "deleted",
    ]
    .iter()
    .all(|k| v[k].as_array().unwrap().is_empty())
}

/// Курсор, после которого собственных записей теста уже нет. Номера транзакций общие на весь
/// кластер Postgres: открытая транзакция соседнего теста держит `xmin` внизу, и сервер корректно
/// присылает лишнее (повторы допустимы). Поэтому идём по цепочке курсоров, пока `xmin` не
/// продвинется за наши записи и дельта не станет пустой.
async fn settled_cursor(app: &axum::Router) -> String {
    let cursor = snapshot(app).await.cursor;
    settle_from(app, cursor).await
}

/// То же, но от заданного курсора: идём по цепочке, пока дельта не станет пустой.
async fn settle_from(app: &axum::Router, mut cursor: String) -> String {
    for _ in 0..500 {
        let v = changes(app, &cursor).await;
        cursor = v["cursor"].as_str().unwrap().to_string();
        if is_empty_delta(&v) {
            return cursor;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("xmin не продвинулся за записи теста");
}

struct Snap {
    lines: Vec<Value>,
    cursor: String,
    raw: String,
}

async fn snapshot(app: &axum::Router) -> Snap {
    let res = send(app, "/api/sync/snapshot", &[]).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "application/x-ndjson");
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let raw = String::from_utf8(bytes.to_vec()).unwrap();
    let lines: Vec<Value> = raw
        .lines()
        .map(|l| serde_json::from_str(l).expect("каждая строка — валидный JSON"))
        .collect();
    let cursor = lines[0]["cursor"].as_str().unwrap().to_string();
    Snap { lines, cursor, raw }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn snapshot_has_begin_rows_in_entity_order_and_end_with_counts(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
    exec(
        &pool,
        "INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (1, 1), (1, 2)",
    )
    .await;
    exec(
        &pool,
        "INSERT INTO track_plays (track_id, play_count, last_played_at) VALUES (2, 3, now())",
    )
    .await;
    let app = router(state(pool));
    let s = snapshot(&app).await;

    assert_eq!(s.lines[0]["type"], "begin");
    assert_eq!(s.lines[0]["schema"], 3);
    assert!(s.cursor.starts_with("3."));
    let types: Vec<&str> = s
        .lines
        .iter()
        .map(|l| l["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "begin",
            "artist",
            "album",
            "track",
            "track",
            "playlist",
            "playlist_track",
            "playlist_track",
            "end"
        ]
    );
    let end = s.lines.last().unwrap();
    assert_eq!(
        end["counts"],
        json!({"artists":1,"albums":1,"tracks":2,"playlists":1,"playlist_tracks":2})
    );
    // нормализованные строки: без склеенных имён
    let track = s
        .lines
        .iter()
        .find(|l| l["row"]["id"] == 2 && l["type"] == "track")
        .unwrap();
    let row = &track["row"];
    assert_eq!(row["album_id"], 1);
    assert_eq!(row["play_count"], 3);
    assert_eq!(row["playback"], "direct");
    assert_eq!(row["needs_confirmation"], false);
    assert!(row.get("album_title").is_none() && row.get("artist_name").is_none());
    assert!(row["last_played_at"].is_string());
    let album = &s.lines[2]["row"];
    assert_eq!(album["secondary_types"], json!([]));
    assert!(album["mbid"].is_string());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn empty_library_snapshot_is_just_begin_and_end(pool: PgPool) {
    let app = router(state(pool));
    let s = snapshot(&app).await;
    assert_eq!(s.lines.len(), 2, "{}", s.raw);
    assert_eq!(s.lines[0]["type"], "begin");
    assert_eq!(s.lines[1]["type"], "end");
    assert_eq!(
        s.lines[1]["counts"],
        json!({"artists":0,"albums":0,"tracks":0,"playlists":0,"playlist_tracks":0})
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn snapshot_reports_transcode_and_confirmation_like_track_view(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO torrents (id, info_hash, magnet, source, title) VALUES (1, repeat('b', 40), 'm', 'tpb', 't')").await;
    exec(&pool, "INSERT INTO torrent_files (torrent_id, file_index, path, size_bytes, ext) VALUES (1, 0, 'a.ape', 1, 'ape'), (1, 1, 'b.flac', 1, 'flac')").await;
    exec(&pool, "INSERT INTO track_sources (track_id, torrent_id, file_index, match_score, is_primary, needs_confirmation) VALUES (1, 1, 0, 1.0, TRUE, TRUE), (2, 1, 1, 1.0, TRUE, FALSE)").await;
    let app = router(state(pool.clone()));
    let s = snapshot(&app).await;
    let find = |id: i64| {
        s.lines
            .iter()
            .find(|l| l["type"] == "track" && l["row"]["id"] == id)
            .unwrap()["row"]
            .clone()
    };
    assert_eq!(find(1)["playback"], "transcode");
    assert_eq!(find(1)["needs_confirmation"], true);
    assert_eq!(find(2)["playback"], "direct");
    // то же самое отдаёт старый API (общий SQL-фрагмент)
    let (_, old) = common::get_json(app.clone(), "/api/tracks/1").await;
    assert_eq!(old["playback"], "transcode");
    assert_eq!(old["needs_confirmation"], true);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changes_without_changes_are_empty_and_a_changed_album_is_alone(pool: PgPool) {
    seed(&pool).await;
    let app = router(state(pool.clone()));
    let c = settled_cursor(&app).await;
    let v = changes(&app, &c).await;
    assert!(
        is_empty_delta(&v) && v["more"] == false && v["reset"] == false,
        "{v}"
    );

    exec(&pool, "UPDATE albums SET title = 'Renamed' WHERE id = 1").await;
    let v = changes(&app, &c).await;
    assert_eq!(ids(&v, "albums"), [1]);
    assert_eq!(v["albums"][0]["title"], "Renamed");
    for k in [
        "artists",
        "tracks",
        "playlists",
        "playlist_tracks",
        "deleted",
    ] {
        assert!(v[k].as_array().unwrap().is_empty(), "{k}: {v}");
    }
    assert_eq!(v["more"], false);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn deletions_arrive_as_deleted_and_cascade_to_children(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO playlists (id, name) VALUES (1, 'P')").await;
    let app = router(state(pool.clone()));
    let c = settled_cursor(&app).await;

    exec(&pool, "DELETE FROM playlists WHERE id = 1").await;
    let v = changes(&app, &c).await;
    assert_eq!(v["deleted"], json!([{"entity": "playlist", "id": 1}]));

    exec(&pool, "DELETE FROM artists WHERE id = 1").await;
    let v = changes(&app, &c).await;
    let mut got: Vec<(String, i64)> = v["deleted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["entity"].as_str().unwrap().to_string(),
                d["id"].as_i64().unwrap(),
            )
        })
        .collect();
    got.sort();
    assert_eq!(
        got,
        [
            ("album".to_string(), 1),
            ("artist".to_string(), 1),
            ("playlist".to_string(), 1),
            ("track".to_string(), 1),
            ("track".to_string(), 2),
        ]
    );
    assert!(v["tracks"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_live_row_and_its_tombstone_never_share_a_response(pool: PgPool) {
    seed(&pool).await;
    let app = router(state(pool.clone()));
    let c = settled_cursor(&app).await;
    exec(&pool, "DELETE FROM tracks WHERE id = 2").await;
    exec(&pool, "INSERT INTO tracks (id, mbid_recording, album_id, artist_id, title, position) VALUES (2, gen_random_uuid(), 1, 1, 'again', 2)").await;
    let v = changes(&app, &c).await;
    assert_eq!(ids(&v, "tracks"), [2]);
    assert!(v["deleted"].as_array().unwrap().is_empty(), "{v}");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn twelve_thousand_changes_come_in_three_pages_without_gaps(pool: PgPool) {
    seed(&pool).await;
    let app = router(state(pool.clone()));
    let c = settled_cursor(&app).await;
    // все 12 000 — одной транзакцией, то есть с одним sync_txid: курсор «по txid» не продвинулся бы
    exec(
        &pool,
        "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position)
                 SELECT gen_random_uuid(), 1, 1, 't', 100 + g FROM generate_series(1, 12000) g",
    )
    .await;
    let expected: BTreeSet<i64> = sqlx::query_scalar("SELECT id FROM tracks WHERE position > 100")
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .collect();
    let mut seen = BTreeSet::new();
    let mut cursor = c;
    let mut more_flags = vec![];
    loop {
        let v = changes(&app, &cursor).await;
        assert!(v["tracks"].as_array().unwrap().len() <= 5000);
        seen.extend(ids(&v, "tracks"));
        more_flags.push(v["more"].as_bool().unwrap());
        cursor = v["cursor"].as_str().unwrap().to_string();
        if !v["more"].as_bool().unwrap() {
            break;
        }
        assert!(more_flags.len() < 10, "курсор не продвигается");
    }
    assert_eq!(more_flags, [true, true, false]);
    assert_eq!(seen, expected);
    // и после полной выгрузки ничего нового нет: пока соседний тест держит xmin, допустимы повторы,
    // поэтому ждём, пока дельта опустеет, а не требуем этого с первого запроса
    settle_from(&app, cursor).await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unusable_cursors_ask_for_a_reset(pool: PgPool) {
    seed(&pool).await;
    let app = router(state(pool.clone()));
    let good = snapshot(&app).await.cursor;
    let parts: Vec<&str> = good.split('.').collect();
    let epoch = parts[1];
    let xmin: i64 = parts[2].parse().unwrap();

    let cases = [
        ("мусор".to_string(), "garbage"),
        (String::new(), "empty"),
        (format!("3.{}.{}", uuid_like(), xmin), "foreign epoch"),
        (format!("1.{epoch}.{xmin}"), "other schema"),
        (format!("3.{epoch}.{}", xmin + 1_000_000), "from the future"),
    ];
    for (cursor, why) in cases {
        let v = changes(&app, &cursor).await;
        assert_eq!(v["reset"], true, "{why}: {v}");
        assert!(is_empty_delta(&v) && v["more"] == false, "{why}");
    }

    // xmin ниже floor: после чистки надгробий старый курсор недействителен
    exec(&pool, "DELETE FROM tracks WHERE id = 1").await;
    exec(
        &pool,
        "UPDATE sync_tombstones SET deleted_at = now() - interval '40 days'",
    )
    .await;
    nimbus_db::repo::sync::purge_tombstones(&pool, nimbus_db::repo::sync::TOMBSTONE_RETENTION)
        .await
        .unwrap();
    let v = changes(&app, &format!("3.{epoch}.1")).await;
    assert_eq!(v["reset"], true, "xmin ниже floor");
    // а курсор выше floor по-прежнему годится (ждём, пока xmin соседних тестов обгонит floor)
    eventually(Duration::from_secs(10), || async {
        let fresh = snapshot(&app).await.cursor;
        changes(&app, &fresh).await["reset"] == false
    })
    .await;
}

fn uuid_like() -> String {
    "00000000-0000-0000-0000-000000000000".into()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changes_requires_a_cursor_parameter(pool: PgPool) {
    let app = router(state(pool));
    let (status, v) = json_of(send(&app, "/api/sync/changes", &[]).await).await;
    assert_eq!(status, 400);
    assert_eq!(v["error"]["code"], "invalid_cursor");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn changes_and_snapshot_are_gzipped_on_request(pool: PgPool) {
    seed(&pool).await;
    let app = router(state(pool));
    let cursor = snapshot(&app).await.cursor;
    // тело для сжатия должно быть заметным: канонический ответ дельты
    let res = send(
        &app,
        &format!("/api/sync/changes?cursor={cursor}"),
        &[("accept-encoding", "gzip")],
    )
    .await;
    assert_eq!(res.headers()["content-encoding"], "gzip");
    let res = send(&app, "/api/sync/snapshot", &[("accept-encoding", "gzip")]).await;
    assert_eq!(res.headers()["content-encoding"], "gzip");
    let res = send(&app, "/api/sync/changes?cursor=x", &[]).await;
    assert!(res.headers().get("content-encoding").is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn sync_poke_follows_a_change_and_bursts_are_coalesced(pool: PgPool) {
    seed(&pool).await;
    let st = state(pool.clone());
    let mut rx = st.events.subscribe();
    let cancel = CancellationToken::new();
    let poker = spawn_sync_poker(st.db.clone(), st.events.clone(), cancel.clone());
    wait_listening(&pool).await;
    // всё, что пришло при старте, не считаем
    tokio::time::sleep(Duration::from_millis(400)).await;
    while rx.try_recv().is_ok() {}

    exec(&pool, "UPDATE tracks SET title = 'x' WHERE id = 1").await;
    let mut got = 0;
    eventually(Duration::from_secs(2), || {
        while let Ok(e) = rx.try_recv() {
            if e == Event::SyncPoke {
                got += 1;
            }
        }
        let ok = got >= 1;
        async move { ok }
    })
    .await;

    // 100 разных уведомлений, доставленных разом, — не больше трёх событий
    tokio::time::sleep(Duration::from_millis(500)).await;
    while rx.try_recv().is_ok() {}
    exec(
        &pool,
        "SELECT pg_notify('nimbus_sync', g::text) FROM generate_series(1, 100) g",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let mut n = 0;
    while let Ok(e) = rx.try_recv() {
        if e == Event::SyncPoke {
            n += 1;
        }
    }
    assert!((1..=3).contains(&n), "событий: {n}");

    cancel.cancel();
    poker.await.unwrap();
}

async fn wait_listening(pool: &PgPool) {
    eventually(Duration::from_secs(5), || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%'",
        )
        .fetch_one(pool)
        .await
        .unwrap()
            > 0
    })
    .await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn sync_poke_after_the_listener_connection_is_lost(pool: PgPool) {
    let st = state(pool.clone());
    let mut rx = st.events.subscribe();
    let cancel = CancellationToken::new();
    let poker = spawn_sync_poker_with(
        st.db.clone(),
        st.events.clone(),
        cancel.clone(),
        Duration::from_millis(50),
        Duration::from_millis(50),
    );
    wait_listening(&pool).await;
    while rx.try_recv().is_ok() {}
    // рвём соединение слушателя
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND query ILIKE 'LISTEN%'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut seen = false;
    eventually(Duration::from_secs(10), || {
        while let Ok(e) = rx.try_recv() {
            seen |= e == Event::SyncPoke;
        }
        let ok = seen;
        async move { ok }
    })
    .await;
    // и слушатель снова работает
    wait_listening(&pool).await;
    while rx.try_recv().is_ok() {}
    exec(
        &pool,
        "INSERT INTO artists (mbid, name) VALUES (gen_random_uuid(), 'new')",
    )
    .await;
    let mut seen = false;
    eventually(Duration::from_secs(5), || {
        while let Ok(e) = rx.try_recv() {
            seen |= e == Event::SyncPoke;
        }
        let ok = seen;
        async move { ok }
    })
    .await;
    cancel.cancel();
    poker.await.unwrap();
}

/// Изменение настроек воспроизведения не меняет `playback` треков: режим зависит только от
/// primary-источника (CUE или формат файла), `settings.playback` в нём не участвует (шаг 34, п. 8).
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn playback_settings_do_not_affect_track_playback_mode(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO torrents (id, info_hash, magnet, source, title) VALUES (1, repeat('c', 40), 'm', 'tpb', 't')").await;
    exec(&pool, "INSERT INTO torrent_files (torrent_id, file_index, path, size_bytes, ext) VALUES (1, 0, 'a.alac', 1, 'alac')").await;
    exec(&pool, "INSERT INTO track_sources (track_id, torrent_id, file_index, match_score, is_primary) VALUES (1, 1, 0, 1.0, TRUE)").await;
    let app = router(state(pool.clone()));
    let before = snapshot(&app).await;
    let (status, _) = common::request_json(
        app.clone(),
        "PUT",
        "/api/settings",
        Some(json!({"playback": {"transcode_alac": true, "transcode_lossy_codec": "mp3"}})),
    )
    .await;
    assert_eq!(status, 200);
    let after = snapshot(&app).await;
    let mode = |s: &Snap| {
        s.lines
            .iter()
            .find(|l| l["type"] == "track" && l["row"]["id"] == 1)
            .unwrap()["row"]["playback"]
            .clone()
    };
    assert_eq!(mode(&before), mode(&after));
}

const TOKEN: &str = "s3cret-token";

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn secured_state(pool: PgPool) -> AppState {
    let mut st = state(pool);
    st.config = Arc::new(
        Config::from_map(&std::collections::HashMap::from([
            ("DATABASE_URL", "postgres://unused"),
            ("NIMBUS_API_TOKEN", TOKEN),
        ]))
        .unwrap(),
    );
    st
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn auth_session_reports_requirement_and_state_without_a_token(pool: PgPool) {
    // авторизация выключена → {false, true}
    let open = router(state(pool.clone()));
    let (status, v) = json_of(send(&open, "/api/auth/session", &[]).await).await;
    assert_eq!(
        (status, v),
        (200, json!({"auth_required": false, "authenticated": true}))
    );

    let app = router(secured_state(pool));
    // эндпоинт сам не требует токена; без токена → {true, false}
    let (status, v) = json_of(send(&app, "/api/auth/session", &[]).await).await;
    assert_eq!(
        (status, v),
        (200, json!({"auth_required": true, "authenticated": false}))
    );
    // с cookie и с Bearer → {true, true}
    let cookie = format!("nimbus_token={}", hex(TOKEN));
    let (_, v) = json_of(send(&app, "/api/auth/session", &[("cookie", &cookie)]).await).await;
    assert_eq!(v, json!({"auth_required": true, "authenticated": true}));
    let bearer = format!("Bearer {TOKEN}");
    let (_, v) =
        json_of(send(&app, "/api/auth/session", &[("authorization", &bearer)]).await).await;
    assert_eq!(v["authenticated"], true);
    // неверный токен — не аутентифицирован, но и не ошибка
    let (status, v) = json_of(
        send(
            &app,
            "/api/auth/session",
            &[("authorization", "Bearer nope")],
        )
        .await,
    )
    .await;
    assert_eq!((status, v["authenticated"].clone()), (200, json!(false)));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn sync_endpoints_require_the_token(pool: PgPool) {
    let app = router(secured_state(pool));
    for uri in ["/api/sync/snapshot", "/api/sync/changes?cursor=1.x.1"] {
        let res = send(&app, uri, &[]).await;
        assert_eq!(res.status(), 401, "{uri}");
    }
    let bearer = format!("Bearer {TOKEN}");
    let res = send(&app, "/api/sync/snapshot", &[("authorization", &bearer)]).await;
    assert_eq!(res.status(), 200);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn closing_the_connection_mid_snapshot_stops_the_source_task(pool: PgPool) {
    seed(&pool).await;
    // достаточно строк, чтобы не поместиться в буфер канала: задача обязана упереться в клиента
    exec(&pool, "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position)
                 SELECT gen_random_uuid(), 1, 1, repeat('x', 200), 100 + g FROM generate_series(1, 60000) g").await;
    let st = state(pool);
    let tasks = st.sync_tasks.clone();
    let app = router(st);
    let res = send(&app, "/api/sync/snapshot", &[]).await;
    assert_eq!(res.status(), 200);
    let mut body = res.into_body();
    // читаем только начало
    let first = body.frame().await.unwrap().unwrap();
    assert!(first.data_ref().is_some_and(|d| !d.is_empty()));
    assert_eq!(
        tasks.load(Ordering::SeqCst),
        1,
        "задача снимка жива, пока читаем"
    );
    drop(body);
    eventually(Duration::from_secs(10), || async {
        tasks.load(Ordering::SeqCst) == 0
    })
    .await;
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn a_database_error_mid_snapshot_aborts_the_body_without_end(pool: PgPool) {
    seed(&pool).await;
    exec(&pool, "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position)
                 SELECT gen_random_uuid(), 1, 1, repeat('x', 200), 100 + g FROM generate_series(1, 60000) g").await;
    // Отдельный пул для приложения: убитое соединение не должно задеть пул теста.
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let st = state(app_pool);
    let tasks = st.sync_tasks.clone();
    let app = router(st);
    let res = send(&app, "/api/sync/snapshot", &[]).await;
    let mut body = res.into_body();
    let mut raw = Vec::new();
    // первый кусок — снимок уже читает треки; клиент дальше не читает, источник упирается в канал
    let first = body.frame().await.unwrap().unwrap();
    raw.extend_from_slice(first.data_ref().unwrap());
    // «администратор» обрывает соединение, которое читает треки
    let killed: i64 = sqlx::query_scalar(
        "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND query LIKE '%FROM tracks t LEFT JOIN track_plays%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(killed, 1);
    let mut errored = false;
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(f) => raw.extend_from_slice(f.data_ref().map_or(&[][..], |d| d)),
            Err(_) => {
                errored = true;
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&raw);
    assert!(
        errored,
        "тело должно оборваться ошибкой, а не закончиться штатно"
    );
    assert!(
        !text.contains("\"type\":\"end\""),
        "строки end быть не должно"
    );
    eventually(Duration::from_secs(5), || async {
        tasks.load(Ordering::SeqCst) == 0
    })
    .await;
}

/// Замер из критериев приёмки шага 34: снимок библиотеки 5 000 альбомов / 60 000 треков.
/// `cargo test -p nimbus-api --test sync snapshot_size_and_time -- --ignored --nocapture`
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
#[ignore = "замер: запускается вручную"]
async fn snapshot_size_and_time(pool: PgPool) {
    exec(&pool, "INSERT INTO artists (mbid, name, sort_name) SELECT gen_random_uuid(), 'Artist ' || g, 'Artist ' || g FROM generate_series(1, 1000) g").await;
    exec(&pool, "INSERT INTO albums (mbid_release_group, artist_id, title, primary_type, year, cover_url, in_library, added_at)
                 SELECT gen_random_uuid(), 1 + (g % 1000), 'Album number ' || g, 'Album', 1970 + g % 50,
                        'https://coverartarchive.org/release-group/' || gen_random_uuid() || '/front-250', TRUE, now()
                   FROM generate_series(1, 5000) g").await;
    exec(&pool, "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position, duration_ms, status, in_library, added_at)
                 SELECT gen_random_uuid(), 1 + (g % 5000), 1 + (g % 1000), 'Track title ' || g, g, 180000 + g, 'ready', TRUE, now()
                   FROM generate_series(1, 60000) g").await;
    let app = router(state(pool));
    let t = std::time::Instant::now();
    let plain = send(&app, "/api/sync/snapshot", &[]).await;
    let plain = plain.into_body().collect().await.unwrap().to_bytes();
    let plain_time = t.elapsed();
    let t = std::time::Instant::now();
    let gz = send(&app, "/api/sync/snapshot", &[("accept-encoding", "gzip")]).await;
    let gz = gz.into_body().collect().await.unwrap().to_bytes();
    let gz_time = t.elapsed();
    println!(
        "snapshot 5000 albums / 60000 tracks: plain {} bytes in {plain_time:?}; gzip {} bytes in {gz_time:?}",
        plain.len(),
        gz.len()
    );
}
