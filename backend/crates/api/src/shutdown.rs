//! Остановка HTTP-сервера с ограниченным дренажом.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Сколько после сигнала ждём, пока открытые HTTP-соединения закроются сами, прежде чем их оборвать.
pub const HTTP_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Запускает сервер и работает, пока `shutdown` не отменён. После отмены сервер перестаёт принимать
/// соединения и ждёт открытые не дольше `drain`, затем обрывается (`abort`), чтобы медленный клиент
/// не задерживал остановку воркеров и торрент-движка. Возвращает ошибку сервера, если он упал сам.
pub async fn serve_until_shutdown(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    shutdown: CancellationToken,
    drain: Duration,
) -> std::io::Result<()> {
    let stop = shutdown.clone();
    let mut server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(stop.cancelled_owned())
        .await
    });
    tokio::select! {
        r = &mut server => return flatten(r),
        _ = shutdown.cancelled() => {}
    }
    match tokio::time::timeout(drain, &mut server).await {
        Ok(r) => flatten(r),
        Err(_) => {
            tracing::warn!(
                drain_secs = drain.as_secs_f32(),
                "http connections did not close in time, aborting them"
            );
            server.abort();
            let _ = server.await;
            Ok(())
        }
    }
}

fn flatten(r: Result<std::io::Result<()>, tokio::task::JoinError>) -> std::io::Result<()> {
    r.map_err(std::io::Error::other)?
}
