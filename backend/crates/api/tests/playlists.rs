// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use common::{delete, get_json, post_json, router, state};
use nimbus_core::model::{NewAlbum, NewArtist, NewTrack};
use nimbus_db::repo::{albums, artists, tracks};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn seed_tracks(pool: &PgPool, n: i32) -> Vec<i64> {
    let artist = artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: "A".into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap();
    let album = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id: artist.id,
            title: "Alb".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(2000),
            cover_url: Some("http://cover".into()),
        },
    )
    .await
    .unwrap();
    let mut ids = vec![];
    for i in 1..=n {
        let t = tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: Some(Uuid::new_v4()),
                album_id: album.id,
                artist_id: artist.id,
                title: format!("T{i}"),
                disc_no: 1,
                position: i,
                duration_ms: Some(1000),
            },
        )
        .await
        .unwrap();
        ids.push(t.id);
    }
    ids
}

fn ids(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn play_count_increments(pool: PgPool) {
    let t = seed_tracks(&pool, 1).await[0];
    let app = router(state(pool));
    let (s, b) = post_json(app.clone(), &format!("/api/tracks/{t}/played"), json!({})).await;
    assert_eq!((s, b["play_count"].as_i64()), (200, Some(1)));
    let (_, b) = post_json(app.clone(), &format!("/api/tracks/{t}/played"), json!({})).await;
    assert_eq!(b["play_count"], 2);
    let (_, b) = get_json(app.clone(), &format!("/api/tracks/{t}")).await;
    assert_eq!(b["play_count"], 2);
    let (s, _) = post_json(app, "/api/tracks/999999/played", json!({})).await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn playlists_sorted_by_last_use_and_dedup(pool: PgPool) {
    let t = seed_tracks(&pool, 3).await;
    let app = router(state(pool));
    let mk = |name: &'static str| {
        let app = app.clone();
        async move {
            let (s, b) = post_json(app, "/api/playlists", json!({ "name": name })).await;
            assert_eq!(s, 201, "{b}");
            b["id"].as_str().unwrap().to_string()
        }
    };
    let a = mk("A").await;
    let b = mk("B").await;
    let c = mk("C").await;
    // Пустое имя отклоняется.
    let (s, _) = post_json(app.clone(), "/api/playlists", json!({"name": "  "})).await;
    assert_eq!(s, 400);

    let (_, list) = get_json(app.clone(), "/api/playlists").await;
    // Favorites первый, затем новые выше.
    assert_eq!(ids(&list["items"]), ["favorites", &c, &b, &a]);

    // Добавили в A — A становится первым среди пользовательских.
    let (s, _) = post_json(
        app.clone(),
        &format!("/api/playlists/{a}/tracks"),
        json!({"track_id": t[0]}),
    )
    .await;
    assert_eq!(s, 204);
    let (_, list) = get_json(app.clone(), "/api/playlists").await;
    assert_eq!(ids(&list["items"]), ["favorites", &a, &c, &b]);
    assert_eq!(list["items"][1]["track_count"], 1);
    assert_eq!(list["items"][1]["cover_url"], "http://cover");

    // Повторное добавление — без дубля, но поднимает плейлист.
    post_json(
        app.clone(),
        &format!("/api/playlists/{b}/tracks"),
        json!({"track_id": t[1]}),
    )
    .await;
    post_json(
        app.clone(),
        &format!("/api/playlists/{a}/tracks"),
        json!({"track_id": t[0]}),
    )
    .await;
    let (_, d) = get_json(app.clone(), &format!("/api/playlists/{a}")).await;
    assert_eq!(d["tracks"].as_array().unwrap().len(), 1);
    let (_, list) = get_json(app.clone(), "/api/playlists").await;
    assert_eq!(ids(&list["items"]), ["favorites", &a, &b, &c]);

    // Неизвестный трек / плейлист.
    let (s, _) = post_json(
        app.clone(),
        &format!("/api/playlists/{a}/tracks"),
        json!({"track_id": 99999}),
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = post_json(
        app.clone(),
        "/api/playlists/99999/tracks",
        json!({"track_id": t[0]}),
    )
    .await;
    assert_eq!(s, 404);

    // Порядок треков — по добавлению; удаление трека и плейлиста.
    post_json(
        app.clone(),
        &format!("/api/playlists/{a}/tracks"),
        json!({"track_id": t[2]}),
    )
    .await;
    let (_, d) = get_json(app.clone(), &format!("/api/playlists/{a}")).await;
    let titles: Vec<_> = d["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["T1", "T3"]);
    let (s, _) = delete(app.clone(), &format!("/api/playlists/{a}/tracks/{}", t[0])).await;
    assert_eq!(s, 204);
    let (s, _) = delete(app.clone(), &format!("/api/playlists/{a}/tracks/{}", t[0])).await;
    assert_eq!(s, 404);
    let (s, _) = delete(app.clone(), &format!("/api/playlists/{a}")).await;
    assert_eq!(s, 204);
    let (s, _) = get_json(app.clone(), &format!("/api/playlists/{a}")).await;
    assert_eq!(s, 404);
    // Трек из удалённого плейлиста остался.
    let (s, _) = get_json(app, &format!("/api/tracks/{}", t[2])).await;
    assert_eq!(s, 200);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn favorites_is_dynamic_top_100(pool: PgPool) {
    let t = seed_tracks(&pool, 102).await;
    // t[0] — 3 прослушивания, t[1] — 2, остальные (кроме последнего) — по одному.
    for (i, &id) in t.iter().enumerate().take(101) {
        let n = match i {
            0 => 3,
            1 => 2,
            _ => 1,
        };
        for _ in 0..n {
            nimbus_db::repo::playlists::record_play(&pool, id)
                .await
                .unwrap();
        }
    }
    let app = router(state(pool));
    let (s, d) = get_json(app.clone(), "/api/playlists/favorites").await;
    assert_eq!(s, 200);
    let tr = d["tracks"].as_array().unwrap();
    assert_eq!(tr.len(), 100);
    assert_eq!(d["playlist"]["track_count"], 100);
    assert_eq!(d["playlist"]["kind"], "favorites");
    assert_eq!(tr[0]["id"], t[0]);
    assert_eq!(tr[0]["play_count"], 3);
    assert_eq!(tr[1]["id"], t[1]);
    // Не прослушанный ни разу трек не попадает.
    assert!(tr.iter().all(|x| x["id"] != t[101]));

    // Favorites нельзя удалить и править вручную.
    let (s, _) = delete(app.clone(), "/api/playlists/favorites").await;
    assert_eq!(s, 409);
    let (s, _) = post_json(
        app,
        "/api/playlists/favorites/tracks",
        json!({"track_id": t[0]}),
    )
    .await;
    assert_eq!(s, 409);
}
