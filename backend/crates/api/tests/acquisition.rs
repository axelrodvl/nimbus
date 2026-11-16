// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{get_json, post_json, request_json, router, state};
use nimbus_core::jobs::{Job, PRIORITY_BACKGROUND, PRIORITY_INTERACTIVE};
use nimbus_core::model::*;
use nimbus_db::repo::{acquisition, albums, artists, jobs, tracks};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use TrackStatus::{Adding, Found, NotFound, Ready};

async fn artist(pool: &PgPool, name: &str) -> i64 {
    artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: name.into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id
}

async fn album(pool: &PgPool, artist_id: i64, title: &str, statuses: &[TrackStatus]) -> i64 {
    let a = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id,
            title: title.into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(1997),
            cover_url: Some("http://img/c.jpg".into()),
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
                title: format!("T{i}"),
                disc_no: 1,
                position: i as i32 + 1,
                duration_ms: None,
            },
        )
        .await
        .unwrap();
        let reason = (*st == NotFound).then_some(NotFoundReason::NoTorrents);
        tracks::set_status(pool, t.id, *st, reason).await.unwrap();
    }
    tracks::set_in_library_for_album(pool, a.id, true)
        .await
        .unwrap();
    a.id
}

fn ids(v: &Value) -> Vec<i64> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["album"]["id"].as_i64().unwrap())
        .collect()
}

async fn queued_discovers(pool: &PgPool) -> Vec<(i64, i16)> {
    let mut v: Vec<(i64, i16)> = jobs::list(pool, Some("queued"), 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == "discover_album")
        .map(|j| (j.payload["album_id"].as_i64().unwrap(), j.priority))
        .collect();
    v.sort_unstable();
    v
}

// ------------------------------------------------------------------ список и сводка

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn list_item_has_the_contracted_shape(pool: PgPool) {
    let ar = artist(&pool, "Radiohead").await;
    let a = album(
        &pool,
        ar,
        "OK Computer",
        &[Found, NotFound, NotFound, Ready],
    )
    .await;
    acquisition::mark_search_started(&pool, a).await.unwrap();
    acquisition::record_search_results(
        &pool,
        a,
        3,
        &json!([{"source": "tpb", "error": "blocked: down"}]),
    )
    .await
    .unwrap();
    acquisition::finish_search(&pool, a, None).await.unwrap();
    jobs::enqueue(
        &pool,
        &Job::VerifyTorrent {
            torrent_id: 1,
            album_id: a,
        },
        jobs::EnqueueOpts::default(),
    )
    .await
    .unwrap();

    let (code, v) = get_json(router(state(pool)), "/api/acquisition").await;
    assert_eq!(code, 200);
    assert!(v["next_cursor"].is_null());
    let item = &v["items"][0];
    assert_eq!(
        item["album"],
        json!({
            "id": a, "title": "OK Computer", "year": 1997, "cover_url": "http://img/c.jpg",
            "artist": {"id": ar, "name": "Radiohead"}
        })
    );
    assert_eq!(item["state"], "partial");
    assert_eq!(
        item["tracks"],
        json!({"total": 4, "adding": 0, "found": 1, "not_found": 2, "ready": 1})
    );
    assert_eq!(item["reason"], "no_torrents");
    assert_eq!(item["download"], Value::Null);
    assert_eq!(item["active_jobs"], 1);
    let s = &item["search"];
    assert_eq!(s["attempts"], 1);
    assert_eq!(s["last_outcome"], "partial");
    assert_eq!(s["candidates"], 3);
    assert_eq!(
        s["provider_errors"][0],
        json!({"source": "tpb", "error": "blocked: down"})
    );
    assert!(s["last_finished_at"].is_string() && s["next_retry_at"].is_string());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn list_filters_orders_and_paginates(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let missing1 = album(&pool, ar, "m1", &[NotFound]).await;
    let missing2 = album(&pool, ar, "m2", &[NotFound]).await;
    let searching = album(&pool, ar, "s", &[Adding]).await;
    let done = album(&pool, ar, "d", &[Ready]).await;
    let app = router(state(pool));

    let (_, v) = get_json(app.clone(), "/api/acquisition").await;
    assert_eq!(ids(&v), vec![searching, missing1, missing2, done]);

    let (_, v) = get_json(app.clone(), "/api/acquisition?state=missing,downloaded").await;
    assert_eq!(ids(&v), vec![missing1, missing2, done]);
    let (_, v) = get_json(app.clone(), "/api/acquisition?state=searching").await;
    assert_eq!(ids(&v), vec![searching]);
    let (_, v) = get_json(app.clone(), "/api/acquisition?state=").await;
    assert_eq!(ids(&v).len(), 4, "пустой фильтр — без фильтра");

    // Страницы по одному: ни дублей, ни пропусков.
    let mut seen = vec![];
    let mut uri = "/api/acquisition?limit=1".to_string();
    loop {
        let (code, v) = get_json(app.clone(), &uri).await;
        assert_eq!(code, 200);
        seen.extend(ids(&v));
        match v["next_cursor"].as_str() {
            Some(c) => uri = format!("/api/acquisition?limit=1&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(seen, vec![searching, missing1, missing2, done]);

    // Лимит ограничивается диапазоном 1..=200.
    let (code, v) = get_json(app, "/api/acquisition?limit=0").await;
    assert_eq!((code, ids(&v).len()), (200, 1));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_ids_filter_limits_the_list_and_validates_input(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let a = album(&pool, ar, "a", &[NotFound]).await;
    let b = album(&pool, ar, "b", &[Ready]).await;
    let _c = album(&pool, ar, "c", &[Adding]).await;
    let app = router(state(pool));

    let (code, v) = get_json(app.clone(), &format!("/api/acquisition?album_ids={a},{b}")).await;
    assert_eq!(code, 200);
    assert_eq!(ids(&v), vec![a, b]);
    // Сочетается с фильтром по состоянию.
    let (_, v) = get_json(
        app.clone(),
        &format!("/api/acquisition?album_ids={a},{b}&state=downloaded"),
    )
    .await;
    assert_eq!(ids(&v), vec![b]);
    // Несуществующий id просто не даёт строки; пустой фильтр — без фильтра.
    let (_, v) = get_json(app.clone(), "/api/acquisition?album_ids=999999").await;
    assert!(ids(&v).is_empty());
    let (_, v) = get_json(app.clone(), "/api/acquisition?album_ids=").await;
    assert_eq!(ids(&v).len(), 3);

    let (code, v) = get_json(app.clone(), "/api/acquisition?album_ids=1,x").await;
    assert_eq!(
        (code, v["error"]["code"].as_str()),
        (400, Some("invalid_album_ids"))
    );
    let many = (1..=101)
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let (code, v) = get_json(app, &format!("/api/acquisition?album_ids={many}")).await;
    assert_eq!(
        (code, v["error"]["code"].as_str()),
        (400, Some("invalid_album_ids"))
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn invalid_state_and_cursor_are_bad_requests(pool: PgPool) {
    let app = router(state(pool));
    let (code, v) = get_json(app.clone(), "/api/acquisition?state=missing,bogus").await;
    assert_eq!(code, 400);
    assert_eq!(v["error"]["code"], "invalid_state");
    let (code, v) = get_json(app.clone(), "/api/acquisition?cursor=zzzz").await;
    assert_eq!(code, 400);
    assert_eq!(v["error"]["code"], "invalid_cursor");
    let (code, _) = get_json(
        app,
        "/api/acquisition?cursor=%27%3B%20DROP%20TABLE%20albums%3B",
    )
    .await;
    assert_eq!(code, 400);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn summary_counts_states_and_failed_jobs(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    album(&pool, ar, "1", &[Adding]).await;
    album(&pool, ar, "2", &[NotFound]).await;
    album(&pool, ar, "3", &[NotFound]).await;
    album(&pool, ar, "4", &[Found, NotFound]).await;
    album(&pool, ar, "5", &[Found]).await;
    album(&pool, ar, "6", &[Ready]).await;
    let id = jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 1 },
        jobs::EnqueueOpts::default(),
    )
    .await
    .unwrap()
    .unwrap();
    jobs::claim(&pool, "w", &["discover_album"]).await.unwrap();
    jobs::fail(&pool, id, "w", "boom", None)
        .await
        .unwrap()
        .unwrap();

    let (code, v) = get_json(router(state(pool)), "/api/acquisition/summary").await;
    assert_eq!(code, 200);
    assert_eq!(
        v,
        json!({
            "searching": 1, "missing": 2, "partial": 1, "available": 1,
            "downloading": 0, "downloaded": 1, "failed_jobs": 1
        })
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn empty_library_gives_empty_page_and_zero_summary(pool: PgPool) {
    let app = router(state(pool));
    let (_, v) = get_json(app.clone(), "/api/acquisition").await;
    assert_eq!(v, json!({"items": [], "next_cursor": null}));
    let (_, v) = get_json(app, "/api/acquisition/summary").await;
    assert_eq!(v["searching"], 0);
}

// ------------------------------------------------------------------ повтор

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_missing_scope_requeues_missing_and_partial_only(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let missing = album(&pool, ar, "m", &[NotFound, NotFound]).await;
    let partial = album(&pool, ar, "p", &[Found, NotFound]).await;
    let found = album(&pool, ar, "f", &[Found]).await;
    sqlx::query(
        "INSERT INTO album_search_state (album_id, auto_retries, next_retry_at) VALUES ($1, 4, now() + interval '30 days')",
    )
    .bind(missing)
    .execute(&pool)
    .await
    .unwrap();

    let app = router(state(pool.clone()));
    let (code, v) = post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "missing"}),
    )
    .await;
    assert_eq!((code, v), (202, json!({"queued": 2})));
    assert_eq!(
        queued_discovers(&pool).await,
        vec![
            (missing, PRIORITY_INTERACTIVE),
            (partial, PRIORITY_INTERACTIVE)
        ]
    );
    let st: Vec<_> = tracks::list_by_album(&pool, missing)
        .await
        .unwrap()
        .into_iter()
        .map(|t| t.status)
        .collect();
    assert_eq!(st, vec![Adding, Adding]);
    let state_row = acquisition::get_state(&pool, missing)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((state_row.auto_retries, state_row.next_retry_at), (0, None));
    let t = tracks::list_by_album(&pool, found).await.unwrap();
    assert_eq!(t[0].status, Found, "найденное не трогаем");

    // Теперь все ищутся: повторять нечего.
    let (_, v) = post_json(app, "/api/acquisition/retry", json!({"scope": "missing"})).await;
    assert_eq!(v, json!({"queued": 0}));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_albums_scope_ignores_unknown_ids(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let a = album(&pool, ar, "a", &[NotFound]).await;
    let b = album(&pool, ar, "b", &[NotFound]).await;
    let app = router(state(pool.clone()));

    let (code, v) = post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": [a, 99_999, a]}),
    )
    .await;
    assert_eq!((code, v), (202, json!({"queued": 1})));
    assert_eq!(
        queued_discovers(&pool).await,
        vec![(a, PRIORITY_INTERACTIVE)]
    );
    assert_eq!(
        tracks::list_by_album(&pool, b).await.unwrap()[0].status,
        NotFound,
        "чужой альбом не затронут"
    );

    let (code, v) = post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": []}),
    )
    .await;
    assert_eq!((code, v), (202, json!({"queued": 0})));
    let (code, v) = post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": [99_999]}),
    )
    .await;
    assert_eq!((code, v), (202, json!({"queued": 0})));

    // Без списка идентификаторов и с неизвестным scope — 400.
    let (code, v) = post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "albums"}),
    )
    .await;
    assert_eq!(code, 400);
    assert_eq!(v["error"]["code"], "bad_request");
    let (code, _) = post_json(
        app,
        "/api/acquisition/retry",
        json!({"scope": "everything"}),
    )
    .await;
    assert_eq!(code, 400);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_rejects_more_than_the_bulk_limit(pool: PgPool) {
    let too_many: Vec<i64> = (1..=5001).collect();
    let (code, v) = post_json(
        router(state(pool)),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": too_many}),
    )
    .await;
    assert_eq!(code, 400);
    assert_eq!(v["error"]["code"], "too_many_albums");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_raises_priority_of_a_waiting_background_search(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let a = album(&pool, ar, "a", &[NotFound]).await;
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: a },
        jobs::EnqueueOpts::priority(PRIORITY_BACKGROUND),
    )
    .await
    .unwrap();
    let (code, v) = post_json(
        router(state(pool.clone())),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": [a]}),
    )
    .await;
    assert_eq!((code, v), (202, json!({"queued": 1})));
    assert_eq!(
        queued_discovers(&pool).await,
        vec![(a, PRIORITY_INTERACTIVE)]
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn retry_with_reset_dead_returns_dead_torrents_to_pending(pool: PgPool) {
    use nimbus_db::repo::{album_torrents, torrents};
    let ar = artist(&pool, "A").await;
    let a = album(&pool, ar, "a", &[NotFound]).await;
    let hash = "ab".repeat(20);
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
    torrents::set_meta_status(&pool, t.id, MetaStatus::Dead, Some("timeout"))
        .await
        .unwrap();
    album_torrents::link(&pool, a, t.id, "q", 0.5)
        .await
        .unwrap();
    album_torrents::mark_verified(&pool, a, t.id).await.unwrap();
    let app = router(state(pool.clone()));

    // Без флага раздача остаётся мёртвой и проверенной.
    post_json(
        app.clone(),
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": [a]}),
    )
    .await;
    assert_eq!(
        torrents::get(&pool, t.id)
            .await
            .unwrap()
            .unwrap()
            .meta_status,
        MetaStatus::Dead
    );
    assert_eq!(album_torrents::count_unverified(&pool, a).await.unwrap(), 0);

    sqlx::query("UPDATE tracks SET status = 'not_found' WHERE album_id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    post_json(
        app,
        "/api/acquisition/retry",
        json!({"scope": "albums", "album_ids": [a], "reset_dead": true}),
    )
    .await;
    let t = torrents::get(&pool, t.id).await.unwrap().unwrap();
    assert_eq!((t.meta_status, t.meta_attempts), (MetaStatus::Pending, 0));
    assert_eq!(album_torrents::count_unverified(&pool, a).await.unwrap(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn existing_retry_endpoints_use_the_same_logic(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let a = album(&pool, ar, "a", &[NotFound, Found]).await;
    sqlx::query(
        "INSERT INTO album_search_state (album_id, auto_retries, next_retry_at) VALUES ($1, 2, now())",
    )
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    let app = router(state(pool.clone()));
    let (code, v) =
        request_json(app.clone(), "POST", &format!("/api/albums/{a}/retry"), None).await;
    assert_eq!((code, v), (202, json!({"queued": true, "tracks_reset": 1})));
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at), (0, None));

    // Повтор одного трека тоже начинает счёт авто-повторов заново.
    sqlx::query(
        "UPDATE album_search_state SET auto_retries = 3, next_retry_at = now() WHERE album_id = $1",
    )
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    let t = tracks::list_by_album(&pool, a).await.unwrap()[1].id;
    let (code, v) = request_json(app, "POST", &format!("/api/tracks/{t}/retry"), None).await;
    assert_eq!((code, v["queued"].as_bool()), (202, Some(true)));
    let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at), (0, None));
}

// ------------------------------------------------------------------ провайдеры

async fn put(app: axum::Router, body: Value) -> (u16, Value) {
    request_json(app, "PUT", "/api/settings", Some(body)).await
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn new_provider_suggests_retry_and_schedules_missing_albums(pool: PgPool) {
    let ar = artist(&pool, "A").await;
    let missing = album(&pool, ar, "m", &[NotFound]).await;
    let partial = album(&pool, ar, "p", &[Found, NotFound]).await;
    let found = album(&pool, ar, "f", &[Found]).await;
    let app = router(state(pool.clone()));

    // Изменение, не связанное с провайдерами, повтор не предлагает.
    let (code, v) = put(app.clone(), json!({"search": {"max_candidates": 9}})).await;
    assert_eq!((code, &v["suggest_retry_missing"]), (200, &json!(false)));
    assert!(acquisition::get_state(&pool, missing)
        .await
        .unwrap()
        .is_none());

    // Новый провайдер.
    let (code, v) = put(
        app.clone(),
        json!({"providers": {"torznab": {"url": "http://tz.example", "api_key": "k"}}}),
    )
    .await;
    assert_eq!((code, &v["suggest_retry_missing"]), (200, &json!(true)));
    for a in [missing, partial] {
        let s = acquisition::get_state(&pool, a).await.unwrap().unwrap();
        assert!(s.next_retry_at.unwrap() <= chrono::Utc::now());
    }
    assert!(acquisition::get_state(&pool, found)
        .await
        .unwrap()
        .is_none());

    // Тот же набор настроек повторно — ничего нового.
    let (_, v) = put(
        app.clone(),
        json!({"providers": {"torznab": {"url": "http://tz.example", "api_key": "k"}}}),
    )
    .await;
    assert_eq!(v["suggest_retry_missing"], false);

    // Изменился ключ — учётные данные другие.
    let (_, v) = put(
        app.clone(),
        json!({"providers": {"torznab": {"url": "http://tz.example", "api_key": "other"}}}),
    )
    .await;
    assert_eq!(v["suggest_retry_missing"], true);

    // Отключение провайдера поиск заново не предлагает.
    let (_, v) = put(app, json!({"providers": {"torznab": null}})).await;
    assert_eq!(v["suggest_retry_missing"], false);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn enabling_tpb_and_rutracker_credentials_suggest_retry(pool: PgPool) {
    let app = router(state(pool));
    // По умолчанию TPB включён: повторное включение ничего не меняет, выключение повтор не предлагает.
    let (_, v) = put(app.clone(), json!({"providers": {"tpb_enabled": true}})).await;
    assert_eq!(v["suggest_retry_missing"], false);
    let (_, v) = put(app.clone(), json!({"providers": {"tpb_enabled": false}})).await;
    assert_eq!(v["suggest_retry_missing"], false);
    let (_, v) = put(app.clone(), json!({"providers": {"tpb_enabled": true}})).await;
    assert_eq!(v["suggest_retry_missing"], true);
    let (_, v) = put(
        app.clone(),
        json!({"providers": {"rutracker": {"username": "bob", "password": "pw"}}}),
    )
    .await;
    assert_eq!(v["suggest_retry_missing"], true);
    // Учётные данные без пароля провайдер не включают.
    let (_, v) = put(
        app,
        json!({"providers": {"rutracker": {"username": "alice", "password": ""}}}),
    )
    .await;
    assert_eq!(
        v["suggest_retry_missing"], true,
        "логин изменился при сохранённом пароле"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn auto_retry_setting_defaults_to_true_and_can_be_turned_off(pool: PgPool) {
    let app = router(state(pool));
    let (_, v) = get_json(app.clone(), "/api/settings").await;
    assert_eq!(v["search"]["auto_retry"], true);
    let (code, v) = put(app, json!({"search": {"auto_retry": false}})).await;
    assert_eq!((code, &v["search"]["auto_retry"]), (200, &json!(false)));
}
