//! Сохранённые `.torrent` раздач: сборка `TorrentRef` из БД, сохранение байтов, полученных движком,
//! и одноразовое дозаполнение из сессии движка.

use bytes::Bytes;
use nimbus_core::model::{InfoHash, Torrent};
use nimbus_db::repo::torrents;
use nimbus_torrent::{FileProvider, TorrentHandleId, TorrentRef};
use sqlx::PgPool;

/// Торрент для движка: magnet и, если в БД сохранён `.torrent`, его байты (тогда метаданные из сети
/// не нужны). Файл читается из БД только когда `has_torrent_file`.
pub async fn torrent_ref(db: &PgPool, torrent: &Torrent) -> sqlx::Result<TorrentRef> {
    let file = if torrent.has_torrent_file {
        torrents::torrent_file(db, torrent.id).await?
    } else {
        None
    };
    Ok(TorrentRef::new(&torrent.magnet, file))
}

/// Если в БД `.torrent` не было, а движок получил его при добавлении торрента — сохраняет.
/// Ошибка БД логируется: потеря кэша не должна ронять воспроизведение.
pub async fn remember_engine_file(
    db: &PgPool,
    files: &dyn FileProvider,
    handle: &TorrentHandleId,
    torrent: &Torrent,
) {
    if torrent.has_torrent_file {
        return;
    }
    let Some(bytes) = files.torrent_file(handle) else {
        return;
    };
    if let Err(e) = torrents::set_torrent_file(db, torrent.id, &bytes).await {
        tracing::warn!(torrent_id = torrent.id, error = %e, "cannot store torrent file");
    }
}

/// Сохраняет `.torrent` торрентов сессии, у которых в БД файла ещё нет. Возвращает, сколько записано.
/// Ошибка одной записи логируется и не прерывает остальные; торренты, которых нет в БД, пропускаются.
pub async fn fill_torrent_files(db: &PgPool, items: Vec<(InfoHash, Bytes)>) -> usize {
    let mut filled = 0;
    for (hash, bytes) in items {
        match torrents::fill_torrent_file_by_hash(db, hash.as_str(), &bytes).await {
            Ok(true) => filled += 1,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(info_hash = %hash, error = %e, "cannot store torrent file from session");
            }
        }
    }
    filled
}
