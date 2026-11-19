// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Эталон состояния альбома на сервере (ревью S11). Тот же файл с примерами проверяет клиентский
//! `albumServerState`: клиент вычисляет состояние из синхронизированных треков, и оно обязано
//! совпадать с `state_cte!`.

use nimbus_db::repo::acquisition;
use serde::Deserialize;
use sqlx::PgPool;

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    tracks: Vec<TrackSpec>,
    expected: Option<Expected>,
}

#[derive(Deserialize)]
struct TrackSpec {
    status: String,
    in_library: bool,
    pin: Option<String>,
    pin_error: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct Expected {
    state: String,
    pinned: bool,
    pin: Option<String>,
    pin_error: Option<String>,
}

const FIXTURE: &str = include_str!("fixtures/album-server-state.json");

async fn exec(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_server_state_matches_fixture(pool: PgPool) {
    let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
    exec(
        &pool,
        "INSERT INTO artists (id, mbid, name) VALUES (1, gen_random_uuid(), 'A')",
    )
    .await;
    exec(&pool, "INSERT INTO torrents (id, info_hash, magnet, source, title) VALUES (1, repeat('a', 40), 'm', 'tpb', 't')").await;
    let mut file_index = 0;
    for (i, case) in fixture.cases.iter().enumerate() {
        let album_id = i as i64 + 1;
        exec(&pool, &format!("INSERT INTO albums (id, mbid_release_group, artist_id, title) VALUES ({album_id}, gen_random_uuid(), 1, 'Al')")).await;
        for (j, t) in case.tracks.iter().enumerate() {
            let track_id: i64 = sqlx::query_scalar(
                "INSERT INTO tracks (mbid_recording, album_id, artist_id, title, position, status, in_library)
                 VALUES (gen_random_uuid(), $1, 1, 'T', $2, $3, $4) RETURNING id",
            )
            .bind(album_id)
            .bind(j as i32 + 1)
            .bind(&t.status)
            .bind(t.in_library)
            .fetch_one(&pool)
            .await
            .unwrap();
            if let Some(pin) = &t.pin {
                sqlx::query(
                    "INSERT INTO pinned_tracks (track_id, album_pin, state, error) VALUES ($1, TRUE, $2, $3)",
                )
                .bind(track_id)
                .bind(pin)
                .bind(&t.pin_error)
                .execute(&pool)
                .await
                .unwrap();
                if pin == "downloading" {
                    // Закрепление «качается» в работе — это активная загрузка primary-файла трека.
                    file_index += 1;
                    exec(&pool, &format!("INSERT INTO track_sources (track_id, torrent_id, file_index, match_score, is_primary) VALUES ({track_id}, 1, {file_index}, 1.0, TRUE)")).await;
                    exec(&pool, &format!("INSERT INTO downloads (torrent_id, file_index, local_path, bytes_total, bytes_done) VALUES (1, {file_index}, 'f', 100, 10)")).await;
                }
            }
        }
        let page = acquisition::list_filtered(&pool, None, Some(&[album_id]), None, 10)
            .await
            .unwrap();
        let actual = page.items.first().map(|r| Expected {
            state: r.state.to_string(),
            pinned: r.pinned,
            pin: r.pin_state.map(|p| p.to_string()),
            pin_error: r.pin_error.clone(),
        });
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}
