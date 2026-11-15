//! Локальный сидер librqbit на 127.0.0.1 для e2e-тестов (фича `test-fakes`).
//! Не используется в боевой сборке.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{
    create_torrent, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};

pub struct FakeSwarm {
    seeder: Arc<Session>,
    pub magnet: String,
    pub info_hash: String,
    pub addr: SocketAddr,
    /// Готовый `.torrent` раздачи.
    pub torrent_file: bytes::Bytes,
}

impl FakeSwarm {
    /// Останавливает сидера (пиров больше нет): проверка «читается без сети».
    pub async fn stop(&self) {
        self.seeder.stop().await;
    }
}

/// Magnet с валидным info-hash, у которого нет пиров: метаданные не придут («глухой» торрент).
pub fn deaf_magnet() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    let hash = format!(
        "{:016x}{:016x}{:08x}",
        nanos,
        N.fetch_add(1, Ordering::Relaxed),
        std::process::id()
    );
    format!("magnet:?xt=urn:btih:{hash}&dn=deaf")
}

/// Пир-«чёрная дыра»: принимает соединения и молчит. Добавленный в `initial_peers`, он не даёт
/// librqbit сразу признать метаданные недостижимыми — запрос висит до таймаута движка.
pub struct Blackhole {
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Blackhole {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Запускает [`Blackhole`] на 127.0.0.1.
pub async fn blackhole() -> std::io::Result<Blackhole> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let addr = listener.local_addr()?;
    let task = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            held.push(sock);
        }
    });
    Ok(Blackhole { addr, task })
}

/// Раздаёт каталог `root/<name>` с файлами `files`; сидер держится, пока жив `FakeSwarm`.
pub async fn start(
    root: &Path,
    name: &str,
    files: &[(String, Vec<u8>)],
) -> anyhow::Result<FakeSwarm> {
    let seeder = Seeder::new(root).await?;
    let album = seeder.add_album(name, files).await?;
    Ok(FakeSwarm {
        addr: seeder.addr,
        seeder: seeder.session,
        magnet: album.magnet,
        info_hash: album.info_hash,
        torrent_file: album.torrent_file,
    })
}

/// Раздача, добавленная на [`Seeder`].
pub struct SeededAlbum {
    pub magnet: String,
    pub info_hash: String,
    pub torrent_file: bytes::Bytes,
}

/// Сидер на 127.0.0.1, раздачи на который добавляются по мере надобности (нагрузочный режим фейков).
pub struct Seeder {
    session: Arc<Session>,
    root: PathBuf,
    pub addr: SocketAddr,
}

impl Seeder {
    pub async fn new(root: &Path) -> anyhow::Result<Self> {
        let session = Session::new_with_opts(
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
        let addr = session
            .listen_addr()
            .ok_or_else(|| anyhow::anyhow!("seeder does not listen"))?;
        Ok(Self {
            session,
            root: root.to_path_buf(),
            addr,
        })
    }

    /// Создаёт раздачу `root/<name>` из `files` и раздаёт её.
    pub async fn add_album(
        &self,
        name: &str,
        files: &[(String, Vec<u8>)],
    ) -> anyhow::Result<SeededAlbum> {
        let album = self.root.join(name);
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
        let torrent_file = bytes.clone();
        let handle = self
            .session
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
        Ok(SeededAlbum {
            magnet: format!("magnet:?xt=urn:btih:{info_hash}&dn={name}"),
            info_hash,
            torrent_file,
        })
    }
}
