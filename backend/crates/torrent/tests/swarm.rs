// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Локальный рой: сидер librqbit на 127.0.0.1 + движок Nimbus как клиент (без DHT и сети).

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{
    create_torrent, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session,
    SessionOptions,
};
use nimbus_torrent::*;
use rand::RngCore;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const FILE_LEN: usize = 3_000_000;
const NAMES: [&str; 3] = ["01 - Intro.flac", "02 - Song.flac", "03 - Outro.flac"];

struct Swarm {
    _seeder: std::sync::Arc<Session>,
    root: PathBuf,
    magnet: String,
    contents: Vec<Vec<u8>>,
    seeder_addr: SocketAddr,
}

fn tmp(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nimbus-swarm-{label}-{}-{}",
        std::process::id(),
        rand::rng().next_u32()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn start_swarm() -> Swarm {
    let root = tmp("seed");
    let album = root.join("Album");
    std::fs::create_dir_all(&album).unwrap();
    let mut contents = vec![];
    for name in NAMES {
        let mut buf = vec![0u8; FILE_LEN];
        rand::rng().fill_bytes(&mut buf);
        std::fs::write(album.join(name), &buf).unwrap();
        contents.push(buf);
    }
    let created = create_torrent(
        &album,
        CreateTorrentOptions {
            piece_length: Some(32 * 1024),
            ..Default::default()
        },
        &BlockingSpawner::new(1),
    )
    .await
    .unwrap();
    let bytes = created.as_bytes().unwrap();

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
    .await
    .unwrap();
    let handle = seeder
        .add_torrent(
            AddTorrent::from_bytes(bytes),
            Some(AddTorrentOptions {
                overwrite: true,
                output_folder: Some(album.to_str().unwrap().to_owned()),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .into_handle()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), handle.wait_until_completed())
        .await
        .expect("seeder checks files")
        .unwrap();

    Swarm {
        seeder_addr: seeder.listen_addr().expect("seeder listens"),
        _seeder: seeder,
        magnet: format!(
            "magnet:?xt=urn:btih:{}&dn=Album",
            created.info_hash().as_string()
        ),
        root,
        contents,
    }
}

async fn engine(swarm: &Swarm, seeding: bool) -> (TorrentEngine, PathBuf) {
    let base = tmp("client");
    let mut cfg = EngineConfig::new(&base, seeding);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.metadata_timeout = Duration::from_secs(30);
    cfg.initial_peers = vec![swarm.seeder_addr];
    (TorrentEngine::new(cfg).await.unwrap(), base)
}

async fn wait_finished(e: &TorrentEngine, id: &TorrentHandleId, idx: usize) -> FileProgress {
    for _ in 0..400 {
        if let Some(p) = e.file_progress(id, idx) {
            if p.finished {
                return p;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("file {idx} did not finish: {:?}", e.file_progress(id, idx));
}

fn cleanup(paths: &[&Path]) {
    for p in paths {
        let _ = std::fs::remove_dir_all(p);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_without_downloading() {
    let swarm = start_swarm().await;
    let (e, base) = engine(&swarm, false).await;

    let meta = e.fetch_metadata(&swarm.magnet).await.unwrap();
    assert_eq!(meta.name, "Album");
    assert_eq!(meta.piece_length, 32 * 1024);
    assert_eq!(meta.files.len(), 3);
    let mut paths: Vec<_> = meta.files.iter().map(|f| f.path.clone()).collect();
    paths.sort();
    assert_eq!(
        paths,
        NAMES.to_vec(),
        "пути внутри торрента (без имени корневой папки), компоненты через '/'"
    );
    assert!(meta.files.iter().all(|f| f.size == FILE_LEN as u64));
    assert_eq!(
        meta.files.iter().map(|f| f.index).collect::<Vec<_>>(),
        [0, 1, 2]
    );

    // Ничего не скачано: торрента нет среди скачиваемых.
    let id = TorrentHandleId(meta.info_hash.clone());
    assert!(e.selected_files(&id).await.is_empty());
    assert!(e.file_progress(&id, 0).is_none());
    cleanup(&[&swarm.root, &base]);
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_seek_reads_exact_bytes_and_only_selected_file_downloads() {
    let swarm = start_swarm().await;
    let (e, base) = engine(&swarm, false).await;
    let meta = e.fetch_metadata(&swarm.magnet).await.unwrap();
    // Индекс файла берём из метаданных (порядок librqbit может отличаться от NAMES).
    let idx = meta
        .files
        .iter()
        .find(|f| f.path.ends_with(NAMES[1]))
        .unwrap()
        .index;
    let other = meta
        .files
        .iter()
        .find(|f| f.path.ends_with(NAMES[0]))
        .unwrap()
        .index;
    let expected = &swarm.contents[1];

    let id = e.ensure_file(&swarm.magnet, idx).await.unwrap();
    assert_eq!(e.selected_files(&id).await, [idx]);
    // Идемпотентно.
    assert_eq!(e.ensure_file(&swarm.magnet, idx).await.unwrap(), id);

    // Чтение с середины файла.
    let mut s = e.open_stream(&id, idx).await.unwrap();
    let mid = (FILE_LEN / 2) as u64;
    assert_eq!(s.seek(std::io::SeekFrom::Start(mid)).await.unwrap(), mid);
    let mut buf = vec![0u8; 4096];
    tokio::time::timeout(Duration::from_secs(30), s.read_exact(&mut buf))
        .await
        .expect("read in time")
        .unwrap();
    assert_eq!(&buf[..], &expected[mid as usize..mid as usize + 4096]);

    // Хвост файла.
    s.seek(std::io::SeekFrom::End(-1000)).await.unwrap();
    let mut tail = vec![];
    tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut tail))
        .await
        .expect("read tail")
        .unwrap();
    assert_eq!(&tail[..], &expected[FILE_LEN - 1000..]);
    drop(s);

    // Соседний файл не выбран: качается только нужный (границы кусков — не больше пары кусков).
    let p_other = e.file_progress(&id, other).unwrap();
    assert!(
        p_other.bytes_done <= 2 * 32 * 1024,
        "файл {other} не должен качаться: {p_other:?}"
    );
    assert!(matches!(
        e.open_stream(&id, other).await,
        Err(EngineError::NotFound)
    ));
    assert!(matches!(
        e.ensure_file(&swarm.magnet, 99).await,
        Err(EngineError::InvalidFileIndex(99))
    ));

    // Прогресс доходит до finished; файл лежит на диске и совпадает с оригиналом.
    let p = wait_finished(&e, &id, idx).await;
    assert_eq!(p.bytes_total, FILE_LEN as u64);
    assert!(p.bytes_done >= FILE_LEN as u64);
    let path = e.file_path(&id, idx).unwrap();
    assert!(path.is_absolute());
    assert_eq!(&std::fs::read(&path).unwrap(), expected);

    cleanup(&[&swarm.root, &base]);
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_grows_and_paused_torrent_resumes() {
    let swarm = start_swarm().await;
    // seeding = false: после завершения торрент ставится на паузу.
    let (e, base) = engine(&swarm, false).await;
    let meta = e.fetch_metadata(&swarm.magnet).await.unwrap();
    let idx_of = |name: &str| {
        meta.files
            .iter()
            .find(|f| f.path.ends_with(name))
            .unwrap()
            .index
    };
    let (a, b) = (idx_of(NAMES[0]), idx_of(NAMES[2]));

    let id = e.ensure_file(&swarm.magnet, a).await.unwrap();
    wait_finished(&e, &id, a).await;
    // Даём наблюдателю поставить торрент на паузу.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Второй файл — набор объединяется, торрент снимается с паузы и докачивает.
    e.ensure_file(&swarm.magnet, b).await.unwrap();
    let mut sorted = vec![a, b];
    sorted.sort_unstable();
    assert_eq!(e.selected_files(&id).await, sorted);
    let mut s = e.open_stream(&id, b).await.unwrap();
    let mut all = vec![];
    tokio::time::timeout(Duration::from_secs(60), s.read_to_end(&mut all))
        .await
        .expect("read whole file")
        .unwrap();
    assert_eq!(all, swarm.contents[2]);
    drop(s);

    // Освобождение файлов: сначала один, затем торрент удаляется из сессии.
    e.release_file(&id, a, false).await.unwrap();
    assert_eq!(e.selected_files(&id).await, [b]);
    e.release_file(&id, b, true).await.unwrap();
    assert!(e.selected_files(&id).await.is_empty());
    assert!(e.file_progress(&id, b).is_none());
    assert!(matches!(
        e.open_stream(&id, b).await,
        Err(EngineError::NotFound)
    ));
    cleanup(&[&swarm.root, &base]);
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_timeout_without_peers() {
    let base = tmp("lonely");
    let mut cfg = EngineConfig::new(&base, false);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.metadata_timeout = Duration::from_millis(500);
    // Пир, который никто не слушает.
    cfg.initial_peers = vec![(Ipv4Addr::LOCALHOST, 9).into()];
    let e = TorrentEngine::new(cfg).await.unwrap();
    let magnet = format!("magnet:?xt=urn:btih:{}", "ab".repeat(20));
    assert!(matches!(
        e.fetch_metadata(&magnet).await,
        Err(EngineError::MetadataTimeout)
    ));
    cleanup(&[&base]);
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_survives_restart() {
    let swarm = start_swarm().await;
    let base = tmp("persist");
    let make_cfg = || {
        let mut cfg = EngineConfig::new(&base, true);
        cfg.dht = false;
        cfg.localhost_only = true;
        cfg.metadata_timeout = Duration::from_secs(30);
        cfg.initial_peers = vec![swarm.seeder_addr];
        cfg
    };
    let e = TorrentEngine::new(make_cfg()).await.unwrap();
    let meta = e.fetch_metadata(&swarm.magnet).await.unwrap();
    let id = e.ensure_file(&swarm.magnet, 1).await.unwrap();
    wait_finished(&e, &id, 1).await;
    assert_eq!(meta.files.len(), 3);
    e.shutdown().await;
    drop(e);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let e2 = TorrentEngine::new(make_cfg()).await.unwrap();
    assert_eq!(
        e2.selected_files(&id).await,
        [1],
        "карта выбранных файлов восстановлена"
    );
    wait_finished(&e2, &id, 1).await;
    cleanup(&[&swarm.root, &base]);
}
