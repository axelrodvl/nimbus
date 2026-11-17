//! Действия при запуске процесса, вынесенные из `main.rs`, чтобы их можно было проверить в тестах.

use nimbus_db::repo::recovery::{self, KickReport};
use sqlx::PgPool;

/// Рывок восстановления при первом запуске новой версии: сохранённая версия отличается от
/// `version` (или отметки нет, а в библиотеке уже есть артисты) — всё отложенное пробуется сразу
/// ([`recovery::kick`]), затем версия записывается. Рестарт той же версии ничего не делает:
/// иначе crash-loop каждый раз заново опрашивал бы провайдеры по всей библиотеке.
/// `None` — рывок не нужен. Вызывать после миграций и до запуска воркеров.
pub async fn recover_on_upgrade(
    db: &PgPool,
    version: &str,
    max_crashes: i32,
) -> sqlx::Result<Option<KickReport>> {
    let stored = nimbus_db::settings::last_version(db).await?;
    if stored.as_deref() == Some(version) {
        return Ok(None);
    }
    if stored.is_none() {
        let has_library: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM artists WHERE in_library)")
                .fetch_one(db)
                .await?;
        if !has_library {
            nimbus_db::settings::set_last_version(db, version).await?;
            return Ok(None);
        }
    }
    let report = recovery::kick(db, max_crashes).await?;
    nimbus_db::settings::set_last_version(db, version).await?;
    tracing::info!(
        from = stored.as_deref().unwrap_or("unknown"),
        to = version,
        albums = report.albums,
        pins = report.pins,
        jobs = report.jobs,
        imports = report.imports,
        "new version: deferred work restarted"
    );
    Ok(Some(report))
}
