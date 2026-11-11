//! Локальный сидер librqbit на 127.0.0.1 для e2e-тестов (фича `test-fakes`).
//! Не используется в боевой сборке.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{
    create_torrent, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};

pub struct FakeSwarm {
    _seeder: Arc<Session>,
    pub magnet: String,
    pub info_hash: String,
    pub addr: SocketAddr,
}

/// Раздаёт каталог `root/<name>` с файлами `files`; сидер держится, пока жив `FakeSwarm`.
pub async fn start(
    root: &Path,
    name: &str,
    files: &[(String, Vec<u8>)],
) -> anyhow::Result<FakeSwarm> {
    let album = root.join(name);
    std::fs::create_dir_all(&album)?;
    for (file, bytes) in files {
        std::fs::write(album.join(file), bytes)?;
    }
    let created = create_torrent(
        &album,
        CreateTorrentOptions {
            piece_length: Some(32 * 1024),
            ..Default::default()
        },
        &BlockingSpawner::new(1),
    )
    .await?;
    let bytes = created.as_bytes()?;
    let seeder = Session::new_with_opts(
        root.join("seeder-session"),
        SessionOptions {
            dht: None,
            disable_local_service_discovery: true,
            listen: Some(ListenerOptions {
                listen_addr: (Ipv4Addr::LOCALHOST, 0).into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await?;
    let handle = seeder
        .add_torrent(
            AddTorrent::from_bytes(bytes),
            Some(AddTorrentOptions {
                overwrite: true,
                output_folder: Some(album.to_string_lossy().into_owned()),
                ..Default::default()
            }),
        )
        .await?
        .into_handle()
        .ok_or_else(|| anyhow::anyhow!("seeder did not return a handle"))?;
    tokio::time::timeout(Duration::from_secs(30), handle.wait_until_completed()).await??;
    let info_hash = created.info_hash().as_string();
    Ok(FakeSwarm {
        addr: seeder
            .listen_addr()
            .ok_or_else(|| anyhow::anyhow!("seeder does not listen"))?,
        _seeder: seeder,
        magnet: format!("magnet:?xt=urn:btih:{info_hash}&dn={name}"),
        info_hash,
    })
}
