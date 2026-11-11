use std::sync::Arc;

use anyhow::Context;
use nimbus_api::{build_router, AppState};
use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_musicbrainz::MbClient;
use nimbus_worker::handlers::default_handlers;
use nimbus_worker::{JobCtx, WorkerConfig, WorkerPool};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Разбор аргументов — до подключения к БД: `--print-openapi` работает без окружения.
    if std::env::args().skip(1).any(|a| a == "--print-openapi") {
        println!("{}", nimbus_api::openapi::openapi().to_pretty_json()?);
        return Ok(());
    }

    // В dev подхватываем .env из корня репозитория (ищется вверх по каталогам).
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,nimbus=debug,nimbus_api=debug,sqlx=warn")),
        )
        .init();

    let config = Config::from_env().context("invalid configuration")?;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("cannot create data dir {}", config.data_dir.display()))?;

    let db = nimbus_db::connect(&config.database_url)
        .await
        .context("cannot connect to database")?;
    nimbus_db::migrate(&db).await.context("migrations failed")?;

    let bind = config.bind;
    let events = EventBus::new();
    let workers = WorkerPool::spawn(
        JobCtx {
            db: db.clone(),
            events: events.clone(),
        },
        default_handlers(),
        WorkerConfig::default(),
    );
    let mb = MbClient::new(&config.mb_user_agent, Some(db.clone()))
        .context("cannot create MusicBrainz client")?;
    let state = AppState::new(db, Arc::new(config), events, mb);
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("cannot bind {bind}"))?;
    tracing::info!(%bind, "nimbus listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    workers.shutdown().await;
    tracing::info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
