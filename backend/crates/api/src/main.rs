use std::sync::Arc;

use anyhow::Context;
use nimbus_api::{build_router, AppState};
use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_musicbrainz::MbClient;
use nimbus_torrent::{EngineConfig, TorrentEngine};
use nimbus_trackers::ProviderRegistry;
use nimbus_worker::handlers::handlers;
use nimbus_worker::{JobCtx, WorkerConfig, WorkerPool};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Разбор аргументов — до подключения к БД: `--print-openapi` работает без окружения.
    if std::env::args().skip(1).any(|a| a == "--print-openapi") {
        // Вывод схемы в stdout — назначение флага, а не отладочная печать.
        #[allow(clippy::print_stdout)]
        {
            println!("{}", nimbus_api::openapi::openapi().to_pretty_json()?);
        }
        return Ok(());
    }

    // В dev подхватываем .env из корня репозитория (ищется вверх по каталогам).
    let _ = dotenvy::dotenv();

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,nimbus=debug,nimbus_api=debug,sqlx=warn"));
    if std::env::var("NIMBUS_LOG_FORMAT").is_ok_and(|v| v.eq_ignore_ascii_case("json")) {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    #[allow(unused_mut)]
    let mut config = Config::from_env().context("invalid configuration")?;
    if config.api_token.is_none() && !config.bind.ip().is_loopback() {
        tracing::warn!(
            bind = %config.bind,
            "NIMBUS_API_TOKEN is not set and the API listens on a non-loopback address: \
             anyone who can reach it has full access"
        );
    }
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("cannot create data dir {}", config.data_dir.display()))?;

    // Начальный пул — для миграций и чтения настроек; размер рабочего зависит от `performance`.
    let boot = nimbus_db::connect(&config.database_url)
        .await
        .context("cannot connect to database")?;
    nimbus_db::migrate(&boot)
        .await
        .context("migrations failed")?;
    let perf = nimbus_db::settings::SettingsStore::load(
        boot.clone(),
        nimbus_core::Settings::from_config(&config),
    )
    .await
    .context("cannot load settings")?
    .get()
    .performance
    .clone();
    let workers_total = u32::from(perf.discover_workers)
        + u32::from(perf.verify_workers)
        + u32::from(perf.import_workers);
    let db = nimbus_db::connect_sized(&config.database_url, nimbus_db::pool_size(workers_total))
        .await
        .context("cannot connect to database")?;
    boot.close().await;

    let bind = config.bind;
    let events = EventBus::new();
    if config.mb_user_agent.contains("your/nimbus") {
        tracing::warn!(
            "NIMBUS_MB_USER_AGENT is still the placeholder: MusicBrainz rate-limits generic clients \
             (503 errors, slow imports). Set it to something like \"Nimbus/0.1 ( you@example.org )\""
        );
    }

    // Фейковые внешние сервисы (только e2e): подменяют MB, провайдеры и пиров.
    let fake_requested = std::env::var("NIMBUS_FAKE_EXTERNAL")
        .is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"));
    #[cfg(not(feature = "test-fakes"))]
    if fake_requested {
        anyhow::bail!("NIMBUS_FAKE_EXTERNAL requires a build with `--features test-fakes`");
    }
    #[cfg(feature = "test-fakes")]
    let fakes = if fake_requested {
        let f = nimbus_api::fakes::start(&config.data_dir).await?;
        config.tpb_enabled = false;
        config.torznab_url = Some(f.torznab_url.clone());
        config.torznab_api_key = None;
        Some(f)
    } else {
        None
    };

    // Настройки из БД поверх env-дефолтов.
    let settings = nimbus_db::settings::SettingsStore::load(
        db.clone(),
        nimbus_core::Settings::from_config(&config),
    )
    .await
    .context("cannot load settings")?;
    // Адрес и лимиты MusicBrainz — из настроек (профиль зеркала — `effective()`);
    // User-Agent по-прежнему из env.
    let initial = settings.get();
    let mb_settings = initial.musicbrainz.effective();
    #[allow(unused_mut)]
    let mut mb_cfg = nimbus_musicbrainz::MbConfig::new(&config.mb_user_agent);
    mb_cfg.base = mb_settings
        .base_url
        .parse()
        .context("invalid musicbrainz.base_url")?;
    mb_cfg.limits = (&mb_settings).into();
    #[cfg(feature = "test-fakes")]
    if let Some(f) = &fakes {
        mb_cfg.base = f.mb_base.parse().context("fake MB url")?;
        mb_cfg.limits = nimbus_musicbrainz::MbLimits::unlimited(8);
        mb_cfg.lb_base = None;
    }
    let mb = MbClient::with_config(mb_cfg, Some(db.clone()))
        .context("cannot create MusicBrainz client")?;
    #[allow(unused_mut)]
    let mut engine_cfg = EngineConfig::new(&config.data_dir, initial.storage.seeding);
    engine_cfg.seed_ratio = initial.storage.seed_ratio;
    engine_cfg.listen_port = Some(config.torrent_port);
    engine_cfg.metadata_concurrency = usize::from(initial.performance.metadata_concurrency);
    engine_cfg.metadata_timeout =
        std::time::Duration::from_secs(u64::from(initial.performance.metadata_timeout_secs));
    engine_cfg.public_trackers = nimbus_trackers::magnet::PUBLIC_TRACKERS
        .iter()
        .map(ToString::to_string)
        .collect();
    #[cfg(feature = "test-fakes")]
    if let Some(f) = &fakes {
        engine_cfg.localhost_only = true;
        engine_cfg.listen_port = None;
        engine_cfg.dht = false;
        engine_cfg.persistence = false;
        engine_cfg.initial_peers = vec![f.peer];
    }
    let engine = Arc::new(
        TorrentEngine::new(engine_cfg)
            .await
            .context("cannot start torrent engine")?,
    );
    // Дозаполнение `.torrent` для торрентов, добавленных до шага 28. Одноразовая короткая задача:
    // не блокирует запуск; при остановке процесса просто прерывается (повтор на следующем старте).
    let backfill = {
        let (db, engine) = (db.clone(), engine.clone());
        tokio::spawn(async move {
            let n = nimbus_worker::torrent_file::fill_torrent_files(
                &db,
                engine.session_torrent_files(),
            )
            .await;
            if n > 0 {
                tracing::info!(count = n, "stored .torrent files of session torrents");
            }
        })
    };
    let providers = Arc::new(ProviderRegistry::new(vec![]));
    providers
        .reload(&initial.providers)
        .context("cannot create torrent providers")?;
    let activity = nimbus_core::activity::Activity::default();
    let workers = WorkerPool::start(
        JobCtx::new(db.clone(), events.clone(), mb.clone(), providers.clone())
            .with_engine(engine.clone())
            .with_settings(settings.clone())
            .with_activity(activity.clone()),
        handlers(&initial.performance),
        WorkerConfig::default(),
    )
    .await
    .context("cannot start workers")?;
    let ffmpeg = std::env::var("NIMBUS_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let transcoder = nimbus_api::transcode::Transcoder::new(ffmpeg)
        .with_raw_base(format!("http://127.0.0.1:{}", bind.port()))
        .probe()
        .await;
    // ffmpeg обязателен: перекодирование (CUE, APE/WV/DSD) и строка качества в плеере.
    anyhow::ensure!(
        transcoder.available,
        "ffmpeg not found (`{}`): install it (e.g. `apt install ffmpeg`) or set NIMBUS_FFMPEG to its path",
        transcoder.ffmpeg
    );
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
    let shutdown = tokio_util::sync::CancellationToken::new();
    let watcher = nimbus_api::stream::spawn_watcher(state.clone(), shutdown.clone());
    let manager =
        nimbus_api::download_manager::spawn_download_manager(state.clone(), shutdown.clone());
    let poker = nimbus_api::sync::spawn_sync_poker(
        state.db.clone(),
        state.events.clone(),
        shutdown.clone(),
    );
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
    shutdown.cancel();
    if let Err(e) = watcher.await {
        tracing::warn!(error = %e, "download watcher did not stop cleanly");
    }
    if let Err(e) = poker.await {
        tracing::warn!(error = %e, "sync poker did not stop cleanly");
    }
    if let Err(e) = manager.await {
        tracing::warn!(error = %e, "download manager did not stop cleanly");
    }
    backfill.abort();
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
