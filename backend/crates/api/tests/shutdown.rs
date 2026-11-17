// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]

use std::time::{Duration, Instant};

use axum::routing::get;
use axum::Router;
use nimbus_api::shutdown::serve_until_shutdown;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const DRAIN: Duration = Duration::from_millis(300);

async fn listener() -> (tokio::net::TcpListener, std::net::SocketAddr) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    (l, a)
}

#[tokio::test]
async fn endless_connection_does_not_block_shutdown_beyond_the_drain_timeout() {
    let app = Router::new().route("/hang", get(std::future::pending::<&'static str>));
    let (l, addr) = listener().await;
    let shutdown = CancellationToken::new();
    let server = tokio::spawn(serve_until_shutdown(l, app, shutdown.clone(), DRAIN));

    // запрос, на который сервер никогда не ответит
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    conn.write_all(b"GET /hang HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    let started = Instant::now();
    shutdown.cancel();
    tokio::time::timeout(DRAIN + Duration::from_secs(2), server)
        .await
        .expect("остановка не должна ждать вечное соединение")
        .unwrap()
        .unwrap();
    assert!(started.elapsed() >= DRAIN, "дренаж ждал положенный срок");
}

#[tokio::test]
async fn idle_server_stops_immediately() {
    let (l, _) = listener().await;
    let shutdown = CancellationToken::new();
    let server = tokio::spawn(serve_until_shutdown(
        l,
        Router::new(),
        shutdown.clone(),
        Duration::from_secs(30),
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("без соединений сервер останавливается сразу")
        .unwrap()
        .unwrap();
}
