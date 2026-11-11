use std::sync::Arc;

use anyhow::Context;
use nimbus_api::{build_router, AppState};
use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::{EngineConfig, TorrentEngine};
use nimbus_trackers::ProviderRegistry;
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
    let mb = MbClient::new(&config.mb_user_agent, Some(db.clone()))
        .context("cannot create MusicBrainz client")?;
    // Настройки из БД поверх env-дефолтов.
    let settings = nimbus_db::settings::SettingsStore::load(
        db.clone(),
        nimbus_core::Settings::from_config(&config),
    )
    .await
    .context("cannot load settings")?;
    let initial = settings.get();
    let engine = Arc::new(
        TorrentEngine::new(EngineConfig::new(&config.data_dir, initial.storage.seeding))
            .await
            .context("cannot start torrent engine")?,
    );
    let providers = Arc::new(ProviderRegistry::new(vec![]));
    providers
        .reload(&initial.providers)
        .context("cannot create torrent providers")?;
    let activity = nimbus_core::activity::Activity::default();
    let workers = WorkerPool::spawn(
        JobCtx::new(db.clone(), events.clone(), mb.clone(), providers.clone())
            .with_engine(engine.clone())
            .with_settings(settings.clone())
            .with_activity(activity.clone()),
        default_handlers(),
        WorkerConfig::default(),
    );
    let ffmpeg = std::env::var("NIMBUS_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let transcoder = nimbus_api::transcode::Transcoder::new(ffmpeg)
        .with_raw_base(format!("http://127.0.0.1:{}", bind.port()))
        .probe()
        .await;
    let state = AppState::new(db, Arc::new(config), events, mb)
        .with_engine(engine.clone())
        .with_settings(settings)
        .with_providers(providers)
        .with_activity(activity)
        .with_transcoder(transcoder);
    match nimbus_api::stream::reconcile_downloads(&state).await {
        Ok(0) => {}
        Ok(n) => tracing::warn!(count = n, "reset downloads whose files are missing"),
        Err(e) => tracing::warn!(error = %e, "downloads reconcile failed"),
    }
    let watcher = nimbus_api::stream::spawn_watcher(state.clone());
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("cannot bind {bind}"))?;
    tracing::info!(%bind, "nimbus listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    watcher.abort();
    workers.shutdown().await;
    engine.shutdown().await;
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
