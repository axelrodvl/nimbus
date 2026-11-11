//! `GET /api/ws` — трансляция событий шины клиентам.

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures::SinkExt;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

const PING_EVERY: Duration = Duration::from_secs(25);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    Ok(ws.on_upgrade(move |socket| serve(socket, state)))
}

async fn serve(mut socket: WebSocket, state: AppState) {
    serve_with(&mut socket, state, PING_EVERY, CLIENT_TIMEOUT).await;
    let _ = socket.close().await;
}

pub(crate) async fn serve_with(
    socket: &mut WebSocket,
    state: AppState,
    ping_every: Duration,
    client_timeout: Duration,
) {
    let mut rx = state.events.subscribe();
    let mut ping = tokio::time::interval(ping_every);
    ping.tick().await; // первый тик срабатывает сразу
    let mut last_seen = Instant::now();

    loop {
        tokio::select! {
            ev = rx.recv() => {
                let text = match ev {
                    Ok(e) => match serde_json::to_string(&e) {
                        Ok(t) => t,
                        Err(err) => {
                            tracing::error!(error = %err, "event serialization failed");
                            continue;
                        }
                    },
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(skipped = n, "ws client lagged, sending resync");
                        r#"{"type":"resync"}"#.to_string()
                    }
                    Err(RecvError::Closed) => return,
                };
                if socket.send(Message::text(text)).await.is_err() {
                    return;
                }
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > client_timeout {
                    tracing::debug!("ws client timed out");
                    return;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            msg = socket.recv() => match msg {
                // Любое входящее сообщение (в т.ч. Pong) — признак жизни; содержимое игнорируем.
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => last_seen = Instant::now(),
            }
        }
    }
}
