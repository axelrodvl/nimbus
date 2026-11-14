// Сквозной тест шага 35: от добавления артиста до байтов из потока. unwrap в тестах допустим.
#![allow(clippy::unwrap_used)]
#![cfg(feature = "test-fakes")]
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use common::rig::{Rig, ALBUM, ARTIST, TRACKS};
use common::{get_json, post_json, request_json, router};
use http_body_util::BodyExt;
use nimbus_api::download_manager::{DownloadManager, ManagerConfig};
use nimbus_api::stream::Watcher;
use nimbus_core::model::TrackStatus;
use nimbus_db::repo::tracks;
use sqlx::PgPool;
use tower::ServiceExt;

pub async fn statuses(pool: &PgPool) -> Vec<(String, String)> {
    sqlx::query_as("SELECT title, status FROM tracks WHERE in_library ORDER BY position")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_to_streamed_bytes_through_the_whole_pipeline(pool: PgPool) {
    let rig = Rig::start(
        pool.clone(),
        1,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
    .await;
    let app = router(rig.state.clone());
    let workers = rig.workers().await;

    // Курсор синхронизации до начала работы: итог проверяем дельтой от него.
    let res = app
        .clone()
        .oneshot(
            Request::get("/api/sync/snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let raw = res.into_body().collect().await.unwrap().to_bytes();
    let first: serde_json::Value =
        serde_json::from_slice(raw.split(|b| *b == b'\n').next().unwrap()).unwrap();
    let cursor = first["cursor"].as_str().unwrap().to_string();

    // 1. Добавляем артиста: импорт → поиск → проверка → все треки `found`.
    let (code, v) = post_json(
        app.clone(),
        "/api/library",
        serde_json::json!({"type": "artist", "mbid": ARTIST}),
    )
    .await;
    assert_eq!(code, 202, "{v}");
    nimbus_testkit::eventually(Duration::from_secs(60), || async {
        let s = statuses(&pool).await;
        s.len() == TRACKS && s.iter().all(|(_, st)| st == "found")
    })
    .await;
    let (album_id,): (i64,) = sqlx::query_as("SELECT id FROM albums WHERE title = $1")
        .bind(ALBUM)
        .fetch_one(&pool)
        .await
        .unwrap();
    let verified: (i64,) =
        sqlx::query_as("SELECT count(*) FROM album_torrents WHERE album_id = $1")
            .bind(album_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(verified.0, 1, "ровно одна раздача на альбом");
    assert!(rig.providers[0].calls() >= 1);

    // 2. Закрепляем альбом: файлы скачиваются движком из локального роя, треки становятся `ready`.
    let (code, v) = request_json(
        app.clone(),
        "POST",
        &format!("/api/albums/{album_id}/download"),
        None,
    )
    .await;
    assert_eq!(
        (code, &v["pinned"]),
        (200, &serde_json::json!(TRACKS)),
        "{v}"
    );
    let mut manager = DownloadManager::new(
        rig.state.clone(),
        ManagerConfig {
            tick: Duration::from_millis(50),
            ..ManagerConfig::default()
        },
    );
    manager.tick().await.unwrap();
    let driver = tokio::sync::Mutex::new((manager, Watcher::new()));
    nimbus_testkit::eventually(Duration::from_secs(60), || async {
        let (m, w) = &mut *driver.lock().await;
        w.tick(&rig.state).await.unwrap();
        m.tick().await.unwrap();
        statuses(&pool).await.iter().all(|(_, st)| st == "ready")
    })
    .await;

    // 3. Стрим отдаёт ровно исходные байты (весь файл и Range).
    for j in 1..=TRACKS {
        let (track_id,): (i64,) = sqlx::query_as("SELECT id FROM tracks WHERE title = $1")
            .bind(common::rig::track_title(j))
            .fetch_one(&pool)
            .await
            .unwrap();
        let want = &rig.contents[j - 1].1;
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/api/tracks/{track_id}/stream"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "track {j}");
        let got = res.into_body().collect().await.unwrap().to_bytes();
        assert!(
            got.as_ref() == want.as_slice(),
            "track {j}: {} байт против {}",
            got.len(),
            want.len()
        );
        let part = app
            .clone()
            .oneshot(
                Request::get(format!("/api/tracks/{track_id}/stream"))
                    .header("range", "bytes=1000-1999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(
            part.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            &want[1000..2000]
        );
        assert_eq!(
            tracks::get(&pool, track_id).await.unwrap().unwrap().status,
            TrackStatus::Ready
        );
    }

    // 4. Синхронизация показывает итоговые статусы.
    let (code, v) = get_json(app.clone(), &format!("/api/sync/changes?cursor={cursor}")).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["reset"], false);
    let mut last: std::collections::BTreeMap<i64, String> = Default::default();
    for t in v["tracks"].as_array().unwrap() {
        last.insert(
            t["id"].as_i64().unwrap(),
            t["status"].as_str().unwrap().to_string(),
        );
    }
    assert_eq!(last.len(), TRACKS);
    assert!(last.values().all(|s| s == "ready"), "{last:?}");

    workers.shutdown().await;
    rig.finish().await;
}
