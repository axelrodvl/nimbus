// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use nimbus_api::{build_router, AppState};
use nimbus_core::events::{Entity, Event, EventBus};
use nimbus_core::model::TrackStatus;
use sqlx::PgPool;
use tokio_tungstenite::tungstenite::Message;

fn state(pool: PgPool, events: EventBus) -> AppState {
    let mut s = common::state(pool);
    s.events = events;
    s
}

async fn serve(state: AppState) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap() });
    addr
}

async fn next_text(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> String {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("stream ended")
            .expect("ws error");
        if let Message::Text(t) = msg {
            return t.to_string();
        }
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn ws_receives_published_events(pool: PgPool) {
    let events = EventBus::new();
    let addr = serve(state(pool, events.clone())).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws"))
        .await
        .unwrap();
    // подписка создаётся при апгрейде; даём серверу время
    tokio::time::sleep(Duration::from_millis(200)).await;

    events.publish(Event::TrackStatus {
        track_id: 5,
        album_id: 2,
        status: TrackStatus::Found,
        reason: None,
    });
    events.publish(Event::LibraryChanged {
        entity: Entity::Album,
        id: 2,
    });
    let v: serde_json::Value = serde_json::from_str(&next_text(&mut ws).await).unwrap();
    assert_eq!(v["type"], "track.status");
    assert_eq!(v["track_id"], 5);
    assert_eq!(v["status"], "found");
    // смена статуса трека сообщает и об изменении приобретения его альбома
    let v: serde_json::Value = serde_json::from_str(&next_text(&mut ws).await).unwrap();
    assert_eq!(v["type"], "acquisition.changed");
    assert_eq!(v["album_id"], 2);
    let v: serde_json::Value = serde_json::from_str(&next_text(&mut ws).await).unwrap();
    assert_eq!(v["type"], "library.changed");

    // входящие сообщения игнорируются, соединение живо
    ws.send(Message::text("hello")).await.unwrap();
    events.publish(Event::LibraryChanged {
        entity: Entity::Track,
        id: 9,
    });
    let v: serde_json::Value = serde_json::from_str(&next_text(&mut ws).await).unwrap();
    assert_eq!(v["id"], 9);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn ws_lagged_client_gets_resync(pool: PgPool) {
    let events = EventBus::new();
    let addr = serve(state(pool, events.clone())).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // переполняем буфер (1024) быстрее, чем клиент читает
    for i in 0..5000 {
        events.publish(Event::LibraryChanged {
            entity: Entity::Track,
            id: i,
        });
    }
    let mut saw_resync = false;
    for _ in 0..6000 {
        let t = next_text(&mut ws).await;
        if t.contains(r#""type":"resync""#) {
            saw_resync = true;
            break;
        }
    }
    assert!(saw_resync);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn debug_jobs_endpoint(pool: PgPool) {
    use nimbus_core::jobs::Job;
    nimbus_db::repo::jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id: 7 },
        nimbus_db::repo::jobs::EnqueueOpts::default(),
    )
    .await
    .unwrap();
    let addr = serve(state(pool, EventBus::new())).await;
    let body: serde_json::Value = reqwest_get(&format!(
        "http://{addr}/api/debug/jobs?state=queued&limit=10"
    ))
    .await;
    assert_eq!(body["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(body["jobs"][0]["kind"], "discover_album");
    let body: serde_json::Value =
        reqwest_get(&format!("http://{addr}/api/debug/jobs?state=done")).await;
    assert!(body["jobs"].as_array().unwrap().is_empty());
}

/// Минимальный HTTP GET без лишних зависимостей.
async fn reqwest_get(url: &str) -> serde_json::Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let u = url.strip_prefix("http://").unwrap();
    let (host, path) = u.split_once('/').unwrap();
    let mut s = tokio::net::TcpStream::connect(host).await.unwrap();
    s.write_all(
        format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let body = buf.split_once("\r\n\r\n").unwrap().1;
    // тело может прийти chunked: берём от первой '{' до последней '}'
    let (a, b) = (body.find('{').unwrap(), body.rfind('}').unwrap());
    serde_json::from_str(&body[a..=b]).unwrap()
}
