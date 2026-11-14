// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Локальный рой: сидер librqbit на 127.0.0.1 + движок Nimbus как клиент (без DHT и сети).
//! Каждый тест — свой временный каталог и свои порты.

use std::net::SocketAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use nimbus_testkit::{eventually, tempdir};
use nimbus_torrent::fake_swarm::{self, FakeSwarm};
use nimbus_torrent::*;
use rand::RngCore;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const FILE_LEN: usize = 3_000_000;
const NAMES: [&str; 3] = ["01 - Intro.flac", "02 - Song.flac", "03 - Outro.flac"];

struct Swarm {
    swarm: FakeSwarm,
    /// Имена файлов и их содержимое в порядке создания (индексы торрента — другие, см. `ix`).
    names: Vec<String>,
    contents: Vec<Vec<u8>>,
    _root: TempDir,
}

impl Swarm {
    fn magnet(&self) -> &str {
        &self.swarm.magnet
    }
    fn addr(&self) -> SocketAddr {
        self.swarm.addr
    }
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// Рой из файлов `files` (имя, размер) в раздаче `Album`.
async fn swarm_of(files: &[(String, usize)]) -> Swarm {
    let root = tempdir();
    let contents: Vec<Vec<u8>> = files.iter().map(|(_, n)| random_bytes(*n)).collect();
    let named: Vec<(String, Vec<u8>)> = files
        .iter()
        .zip(&contents)
        .map(|((n, _), c)| (n.clone(), c.clone()))
        .collect();
    let swarm = fake_swarm::start(root.path(), "Album", &named)
        .await
        .unwrap();
    Swarm {
        swarm,
        names: files.iter().map(|(n, _)| n.clone()).collect(),
        contents,
        _root: root,
    }
}

/// Стандартный рой: три файла по 3 МБ.
async fn start_swarm() -> Swarm {
    let files: Vec<_> = NAMES.iter().map(|n| (n.to_string(), FILE_LEN)).collect();
    swarm_of(&files).await
}

fn base_cfg(base: &Path, peers: Vec<SocketAddr>, seeding: bool) -> EngineConfig {
    let mut cfg = EngineConfig::new(base, seeding);
    cfg.dht = false;
    cfg.persistence = false;
    cfg.localhost_only = true;
    cfg.metadata_timeout = Duration::from_secs(30);
    cfg.initial_peers = peers;
    cfg
}

async fn engine(swarm: &Swarm, seeding: bool) -> (TorrentEngine, TempDir) {
    let base = tempdir();
    let cfg = base_cfg(base.path(), vec![swarm.addr()], seeding);
    (TorrentEngine::new(cfg).await.unwrap(), base)
}

async fn wait_finished(e: &TorrentEngine, id: &TorrentHandleId, idx: usize) -> FileProgress {
    let mut last = None;
    eventually(Duration::from_secs(30), || {
        last = e.file_progress(id, idx);
        let done = last.is_some_and(|p| p.finished);
        async move { done }
    })
    .await;
    last.unwrap()
}

fn index_of(meta: &TorrentMeta, name: &str) -> usize {
    meta.files
        .iter()
        .find(|f| f.path.ends_with(name))
        .unwrap()
        .index
}

/// Индексы файлов в торренте в порядке `swarm.names` (librqbit перечисляет файлы в порядке обхода
/// каталога, он не обязан совпадать с порядком создания).
async fn ix(e: &TorrentEngine, swarm: &Swarm) -> Vec<usize> {
    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
    swarm.names.iter().map(|n| index_of(&meta, n)).collect()
}

fn state_of(e: &TorrentEngine, id: &TorrentHandleId) -> Option<TorrentState> {
    e.list_torrents()
        .into_iter()
        .find(|t| t.info_hash == id.0)
        .map(|t| t.state)
}

async fn wait_state(e: &TorrentEngine, id: &TorrentHandleId, want: TorrentState) {
    eventually(Duration::from_secs(15), || async {
        state_of(e, id) == Some(want)
    })
    .await;
}

async fn read_all(e: &TorrentEngine, id: &TorrentHandleId, idx: usize) -> Vec<u8> {
    let mut s = e.open_stream(id, idx).await.unwrap();
    let mut all = vec![];
    tokio::time::timeout(Duration::from_secs(60), s.read_to_end(&mut all))
        .await
        .expect("read whole file")
        .unwrap();
    all
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_without_downloading() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;

    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
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
    assert!(e.list_torrents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_seek_reads_exact_bytes_and_only_selected_file_downloads() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
    // Индекс файла берём из метаданных (порядок librqbit может отличаться от NAMES).
    let idx = index_of(&meta, NAMES[1]);
    let other = index_of(&meta, NAMES[0]);
    let expected = &swarm.contents[1];

    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), idx)
        .await
        .unwrap();
    assert_eq!(e.selected_files(&id).await, [idx]);
    assert_eq!(
        e.ensure_file(&TorrentRef::magnet(swarm.magnet()), idx)
            .await
            .unwrap(),
        id
    );

    // Чтение с начала.
    let mut s = e.open_stream(&id, idx).await.unwrap();
    let mut head = vec![0u8; 4096];
    tokio::time::timeout(Duration::from_secs(30), s.read_exact(&mut head))
        .await
        .expect("read head")
        .unwrap();
    assert_eq!(&head[..], &expected[..4096]);

    // Чтение с середины файла.
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

    // Прогресс доходит до finished; файл лежит на диске и совпадает с оригиналом.
    let p = wait_finished(&e, &id, idx).await;
    assert_eq!(p.bytes_total, FILE_LEN as u64);
    assert!(p.bytes_done >= FILE_LEN as u64);
    let path = e.file_path(&id, idx).unwrap();
    assert!(path.is_absolute());
    assert_eq!(&std::fs::read(&path).unwrap(), expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_grows_and_paused_torrent_resumes() {
    let swarm = start_swarm().await;
    // seeding = false: после завершения торрент ставится на паузу.
    let (e, _base) = engine(&swarm, false).await;
    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
    let (a, b) = (index_of(&meta, NAMES[0]), index_of(&meta, NAMES[2]));

    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), a)
        .await
        .unwrap();
    wait_finished(&e, &id, a).await;
    wait_state(&e, &id, TorrentState::Paused).await;

    // Второй файл — набор объединяется, торрент снимается с паузы и докачивает.
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), b)
        .await
        .unwrap();
    let mut sorted = vec![a, b];
    sorted.sort_unstable();
    assert_eq!(e.selected_files(&id).await, sorted);
    assert_eq!(read_all(&e, &id, b).await, swarm.contents[2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_timeout_without_peers() {
    let base = tempdir();
    let mut cfg = base_cfg(
        base.path(),
        vec![(std::net::Ipv4Addr::LOCALHOST, 9).into()],
        false,
    );
    cfg.metadata_timeout = Duration::from_millis(500);
    // Пир, который никто не слушает.
    let e = TorrentEngine::new(cfg).await.unwrap();
    assert!(matches!(
        e.fetch_metadata(&fake_swarm::deaf_magnet()).await,
        Err(EngineError::MetadataTimeout)
    ));
}

/// Движок с пиром-«чёрной дырой»: глухой торрент висит до таймаута, а не падает сразу.
async fn engine_with_blackhole(
    swarm: &Swarm,
    timeout: Duration,
    seeding: bool,
) -> (TorrentEngine, TempDir, fake_swarm::Blackhole) {
    let hole = fake_swarm::blackhole().await.unwrap();
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![swarm.addr(), hole.addr], seeding);
    cfg.metadata_timeout = timeout;
    (TorrentEngine::new(cfg).await.unwrap(), base, hole)
}

#[tokio::test(flavor = "multi_thread")]
async fn deaf_torrent_does_not_block_a_live_one() {
    let swarm = start_swarm().await;
    let (e, _base, _hole) = engine_with_blackhole(&swarm, Duration::from_secs(2), false).await;
    let e = std::sync::Arc::new(e);

    let deaf = fake_swarm::deaf_magnet();
    let started = Instant::now();
    let slow = {
        let e = e.clone();
        tokio::spawn(async move { e.ensure_file(&TorrentRef::magnet(&deaf), 0).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await; // глухой уже держит свой слот

    let first = ix(&e, &swarm).await[0];
    let live = Instant::now();
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), first)
        .await
        .unwrap();
    let mut s = e.open_stream(&id, first).await.unwrap();
    let mut buf = vec![0u8; 4096];
    tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut buf))
        .await
        .expect("live read")
        .unwrap();
    assert_eq!(&buf[..], &swarm.contents[0][..4096]);
    let took = live.elapsed();
    assert!(
        took < Duration::from_secs(1),
        "живой торрент ждал глухой: {took:?}"
    );
    // Сводка не ждёт долгих операций.
    let _ = (e.list_torrents(), e.stats());

    assert!(matches!(
        slow.await.unwrap(),
        Err(EngineError::MetadataTimeout)
    ));
    assert!(started.elapsed() >= Duration::from_secs(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_cleans_up_session_and_slot() {
    let swarm = start_swarm().await;
    let (e, _base, _hole) = engine_with_blackhole(&swarm, Duration::from_secs(1), false).await;
    let deaf = fake_swarm::deaf_magnet();
    assert!(matches!(
        e.ensure_file(&TorrentRef::magnet(&deaf), 0).await,
        Err(EngineError::MetadataTimeout)
    ));
    assert!(
        e.list_torrents().is_empty(),
        "торрент не должен остаться в сессии"
    );
    assert_eq!(e.tracked_torrents(), 0, "слот должен быть убран");
    // Движок работоспособен: живой торрент добавляется как обычно.
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    assert_eq!(e.tracked_torrents(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_ensure_file_on_one_torrent_merges_selection() {
    let files: Vec<_> = (0..10)
        .map(|i| (format!("{i:02}.flac"), 64 * 1024))
        .collect();
    let swarm = swarm_of(&files).await;
    let (e, _base) = engine(&swarm, true).await;
    let e = std::sync::Arc::new(e);

    let mut tasks = vec![];
    for i in 0..10 {
        let (e, magnet) = (e.clone(), swarm.magnet().to_string());
        tasks.push(tokio::spawn(async move {
            e.ensure_file(&TorrentRef::magnet(&magnet), i).await
        }));
    }
    let mut ids = vec![];
    for t in tasks {
        ids.push(t.await.unwrap().unwrap());
    }
    assert!(ids.windows(2).all(|w| w[0] == w[1]));
    assert_eq!(e.selected_files(&ids[0]).await, (0..10).collect::<Vec<_>>());
    assert_eq!(e.list_torrents().len(), 1, "торрент в сессии один");
    for i in 0..10 {
        wait_finished(&e, &ids[0], i).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_ensure_file_is_a_fast_noop() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 1)
        .await
        .unwrap();
    let t = Instant::now();
    for _ in 0..20 {
        assert_eq!(
            e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 1)
                .await
                .unwrap(),
            id
        );
    }
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    assert_eq!(e.selected_files(&id).await, [1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_file_index_for_new_torrent_removes_it_from_session() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    assert!(matches!(
        e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 99).await,
        Err(EngineError::InvalidFileIndex(99))
    ));
    assert!(e.list_torrents().is_empty());
    assert_eq!(e.tracked_torrents(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_file_index_for_added_torrent_keeps_it() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    assert!(matches!(
        e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 99).await,
        Err(EngineError::InvalidFileIndex(99))
    ));
    assert!(matches!(
        e.open_stream(&id, 99).await,
        Err(EngineError::InvalidFileIndex(99))
    ));
    assert_eq!(e.selected_files(&id).await, [0]);
    assert_eq!(e.list_torrents().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_file_set_is_rejected() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    assert!(matches!(
        e.ensure_files(&TorrentRef::magnet(swarm.magnet()), &[])
            .await,
        Err(EngineError::Internal(_))
    ));
    assert!(e.list_torrents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_files_downloads_the_set_and_nothing_else() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let ix = ix(&e, &swarm).await;
    let id = e
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[ix[0], ix[2]])
        .await
        .unwrap();
    let mut chosen = vec![ix[0], ix[2]];
    chosen.sort_unstable();
    assert_eq!(e.selected_files(&id).await, chosen);
    wait_finished(&e, &id, ix[0]).await;
    wait_finished(&e, &id, ix[2]).await;
    assert_eq!(
        std::fs::read(e.file_path(&id, ix[0]).unwrap()).unwrap(),
        swarm.contents[0]
    );
    assert_eq!(
        std::fs::read(e.file_path(&id, ix[2]).unwrap()).unwrap(),
        swarm.contents[2]
    );
    let middle = e.file_progress(&id, ix[1]).unwrap();
    assert!(
        middle.bytes_done <= 2 * 32 * 1024,
        "невыбранный файл не качается: {middle:?}"
    );
    assert!(matches!(
        e.open_stream(&id, ix[1]).await,
        Err(EngineError::NotFound)
    ));
    // Добавление к существующему торренту — одним вызовом.
    e.ensure_files(&TorrentRef::magnet(swarm.magnet()), &[ix[1], ix[2]])
        .await
        .unwrap();
    assert_eq!(e.selected_files(&id).await, [0, 1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn release_file_shrinks_selection_and_removes_last_torrent() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[0, 1])
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_finished(&e, &id, 1).await;
    let p0 = e.file_path(&id, 0).unwrap();
    let p1 = e.file_path(&id, 1).unwrap();

    e.release_file(&id, 0, false).await.unwrap();
    assert_eq!(e.selected_files(&id).await, [1]);
    assert!(p0.exists(), "без delete_data файл остаётся на диске");

    e.release_file(&id, 1, true).await.unwrap();
    assert!(e.selected_files(&id).await.is_empty());
    assert!(
        e.list_torrents().is_empty(),
        "последний файл — торрент удалён"
    );
    assert_eq!(e.tracked_torrents(), 0);
    assert!(!p1.exists(), "delete_data удаляет файл с диска");
    assert!(matches!(
        e.open_stream(&id, 1).await,
        Err(EngineError::NotFound)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn release_file_with_delete_data_removes_file_of_a_still_selected_torrent() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[0, 1])
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    let p0 = e.file_path(&id, 0).unwrap();
    e.release_file(&id, 0, true).await.unwrap();
    assert!(!p0.exists());
    assert_eq!(e.selected_files(&id).await, [1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn release_file_of_unknown_torrent_is_not_found() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let unknown = TorrentHandleId(nimbus_core::model::InfoHash::parse(&"cd".repeat(20)).unwrap());
    assert!(matches!(
        e.release_file(&unknown, 0, false).await,
        Err(EngineError::NotFound)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn seeding_policy_pauses_and_resumes_finished_torrents() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let ix = ix(&e, &swarm).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), ix[0])
        .await
        .unwrap();
    wait_finished(&e, &id, ix[0]).await;
    // seeding = false: после завершения — пауза.
    wait_state(&e, &id, TorrentState::Paused).await;

    e.set_seeding(true).await;
    wait_state(&e, &id, TorrentState::Seeding).await;
    e.set_seeding(false).await;
    wait_state(&e, &id, TorrentState::Paused).await;

    // Новый файл в завершённом торренте на паузе → возобновляется и докачивает.
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), ix[2])
        .await
        .unwrap();
    assert_eq!(read_all(&e, &id, ix[2]).await, swarm.contents[2]);
    wait_state(&e, &id, TorrentState::Paused).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ratio_watcher_pauses_torrent_at_the_limit_and_resume_follows_limit_change() {
    let swarm = start_swarm().await;
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![swarm.addr()], true);
    cfg.seed_ratio = Some(0.0); // любой завершённый торрент уже «достиг» лимита
    cfg.ratio_check_interval = Duration::from_millis(50);
    let e = TorrentEngine::new(cfg).await.unwrap();
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Paused).await;

    // Лимит снят — раздача возобновляется.
    e.set_seed_ratio(None).await;
    assert_eq!(e.seed_ratio(), None);
    wait_state(&e, &id, TorrentState::Seeding).await;
    // Снова включили лимит — watcher опять останавливает.
    e.set_seed_ratio(Some(0.0)).await;
    wait_state(&e, &id, TorrentState::Paused).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_and_resume_torrent_change_state() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Seeding).await;

    e.pause_torrent(&id).await.unwrap();
    assert_eq!(state_of(&e, &id), Some(TorrentState::Paused));
    e.pause_torrent(&id).await.unwrap(); // повтор безопасен
    e.resume_torrent(&id).await.unwrap();
    wait_state(&e, &id, TorrentState::Seeding).await;

    let unknown = TorrentHandleId(nimbus_core::model::InfoHash::parse(&"ee".repeat(20)).unwrap());
    assert!(matches!(
        e.pause_torrent(&unknown).await,
        Err(EngineError::NotFound)
    ));
    assert!(matches!(
        e.resume_torrent(&unknown).await,
        Err(EngineError::NotFound)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn list_torrents_and_stats_report_the_session() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    assert_eq!(e.stats().torrents, 0);
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    let list = e.list_torrents();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Album");
    assert_eq!(list[0].info_hash, id.0);
    assert_eq!(e.stats().torrents, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_pause_task_per_torrent() {
    let swarm = start_swarm().await;
    // seeding = false: каждая операция заводит «паузу по завершении».
    let (e, _base) = engine(&swarm, false).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 1)
        .await
        .unwrap();
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 2)
        .await
        .unwrap();
    // Ratio-watcher + не больше одной задачи на торрент.
    eventually(Duration::from_secs(5), || async {
        e.background_tasks() <= 2
    })
    .await;
    wait_finished(&e, &id, 2).await;
    wait_state(&e, &id, TorrentState::Paused).await;
    eventually(Duration::from_secs(5), || async {
        e.background_tasks() <= 1
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_and_data_survive_restart_and_read_without_network() {
    let swarm = start_swarm().await;
    let base = tempdir();
    let make_cfg = |peers: Vec<SocketAddr>| {
        let mut cfg = base_cfg(base.path(), peers, true);
        cfg.persistence = true;
        cfg
    };
    let e = TorrentEngine::new(make_cfg(vec![swarm.addr()]))
        .await
        .unwrap();
    let one = ix(&e, &swarm).await[1];
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), one)
        .await
        .unwrap();
    wait_finished(&e, &id, one).await;
    e.shutdown().await;
    drop(e);
    // Сидер останавливаем: дальше сети нет.
    swarm.swarm.stop().await;

    let e2 = TorrentEngine::new(make_cfg(vec![])).await.unwrap();
    assert_eq!(
        e2.selected_files(&id).await,
        [one],
        "карта выбранных файлов восстановлена"
    );
    wait_finished(&e2, &id, one).await;
    assert_eq!(read_all(&e2, &id, one).await, swarm.contents[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_stops_background_tasks_and_is_idempotent() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    assert!(e.background_tasks() >= 1);
    e.shutdown().await;
    assert_eq!(e.background_tasks(), 0);
    e.shutdown().await; // повторный вызов безопасен
    assert_eq!(e.background_tasks(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn busy_listen_port_falls_back_to_a_random_one() {
    let busy = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = busy.local_addr().unwrap().port();
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![], true);
    cfg.listen_port = Some(port);
    let e = TorrentEngine::new(cfg).await.unwrap();
    let got = e.listen_addr().expect("движок слушает").port();
    assert_ne!(got, port);
    assert_ne!(got, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn configured_free_listen_port_is_used() {
    // Свободный порт ищем вне диапазона эфемерных портов ОС (32768+): параллельные тесты берут
    // порты `bind(0)` именно оттуда и могли бы занять «наш» между проверкой и стартом движка.
    let port = (20_000u16..30_000)
        .find(|p| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *p)).is_ok())
        .expect("a free port below the ephemeral range");
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![], true);
    cfg.listen_port = Some(port);
    let e = TorrentEngine::new(cfg).await.unwrap();
    assert_eq!(e.listen_addr().map(|a| a.port()), Some(port));
}

#[tokio::test(flavor = "multi_thread")]
async fn disk_error_on_add_is_a_storage_error_and_leaves_nothing_behind() {
    let swarm = start_swarm().await;
    let base = tempdir();
    let cfg = base_cfg(base.path(), vec![swarm.addr()], true);
    let data = cfg.data_dir.clone();
    let e = TorrentEngine::new(cfg).await.unwrap();
    // На месте папки раздачи лежит обычный файл: создать файлы торрента невозможно.
    std::fs::write(data.join("Album"), b"not a directory").unwrap();
    let err = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap_err();
    assert!(matches!(err, EngineError::Storage(_)), "{err:?}");
    assert!(e.list_torrents().is_empty());
    assert_eq!(e.tracked_torrents(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn engine_works_through_the_provider_traits() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let ix = ix(&e, &swarm).await;
    let fetcher: &dyn MetadataFetcher = &e;
    let meta = fetcher.fetch_metadata(swarm.magnet()).await.unwrap();
    assert_eq!(meta.files.len(), 3);

    let files: &dyn FileProvider = &e;
    let id = files
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), ix[0])
        .await
        .unwrap();
    let same = files
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[ix[0], ix[1]])
        .await
        .unwrap();
    assert_eq!(id, same);
    wait_finished(&e, &id, ix[1]).await;
    assert!(files.file_progress(&id, ix[1]).unwrap().finished);
    assert!(files.file_path(&id, ix[1]).unwrap().is_file());
    let mut s = files.open_stream(&id, ix[1]).await.unwrap();
    let mut head = vec![0u8; 1024];
    s.read_exact(&mut head).await.unwrap();
    assert_eq!(&head[..], &swarm.contents[1][..1024]);
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_of_a_torrent_already_in_the_session_needs_no_network() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    // Сидер остановлен: метаданные берутся из сессии.
    swarm.swarm.stop().await;
    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
    assert_eq!(meta.files.len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_file_on_finished_paused_torrent_keeps_it_paused() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Paused).await;
    // Файл уже скачан: повторный запрос не возобновляет торрент.
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    assert_eq!(state_of(&e, &id), Some(TorrentState::Paused));
}

fn with_file(swarm: &Swarm) -> TorrentRef {
    TorrentRef {
        magnet: swarm.magnet().to_string(),
        torrent_file: Some(swarm.swarm.torrent_file.clone()),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_metadata_returns_torrent_file_that_parses_to_the_same_meta() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let fetched = e.fetch_metadata(swarm.magnet()).await.unwrap();
    let bytes = fetched
        .torrent_file
        .clone()
        .expect("torrent_file is returned");

    let parsed = parse_torrent_file(&bytes, Some(&fetched.info_hash)).unwrap();
    assert_eq!(parsed.info_hash, fetched.info_hash);
    assert_eq!(parsed.name, fetched.name);
    assert_eq!(parsed.files, fetched.files);
    assert_eq!(parsed.piece_length, fetched.piece_length);
    assert_eq!(parsed.piece_length, 32 * 1024);
    assert_eq!(parsed.torrent_file.as_deref(), Some(&bytes[..]));
    // Оригинальный .torrent сидера даёт те же метаданные.
    let original = parse_torrent_file(&swarm.swarm.torrent_file, None).unwrap();
    assert_eq!(original.files, fetched.files);
}

#[tokio::test]
async fn parse_torrent_file_rejects_garbage_and_foreign_hash() {
    assert!(matches!(
        parse_torrent_file(b"definitely not bencode", None),
        Err(EngineError::Internal(m)) if m.contains("invalid torrent file")
    ));
    assert!(matches!(
        parse_torrent_file(b"", None),
        Err(EngineError::Internal(_))
    ));
    let swarm = start_swarm().await;
    let other = nimbus_core::model::InfoHash::parse(&"cd".repeat(20)).unwrap();
    assert!(matches!(
        parse_torrent_file(&swarm.swarm.torrent_file, Some(&other)),
        Err(EngineError::Internal(m)) if m == "info-hash mismatch"
    ));
    let own = nimbus_core::model::InfoHash::parse(&swarm.swarm.info_hash).unwrap();
    assert!(parse_torrent_file(&swarm.swarm.torrent_file, Some(&own)).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_file_with_torrent_file_works_when_metadata_is_unreachable() {
    let swarm = start_swarm().await;
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![swarm.addr()], false);
    cfg.metadata_timeout = Duration::from_secs(1);
    let e = TorrentEngine::new(cfg).await.unwrap();
    swarm.swarm.stop().await;

    // Без байтов метаданные недоступны — таймаут (и ничего не остаётся в сессии).
    assert!(matches!(
        e.ensure_file(&TorrentRef::magnet(swarm.magnet()), 0).await,
        Err(EngineError::MetadataTimeout)
    ));
    assert_eq!(e.tracked_torrents(), 0);

    // С байтами торрент добавляется сразу, без сети.
    let started = Instant::now();
    let id = e.ensure_file(&with_file(&swarm), 1).await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(900));
    assert_eq!(e.selected_files(&id).await, vec![1]);
    assert_eq!(e.tracked_torrents(), 1);
    assert_eq!(e.list_torrents().len(), 1);
    assert!(e.torrent_file(&id).is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_with_torrent_file_reads_correct_data() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let meta = parse_torrent_file(&swarm.swarm.torrent_file, None).unwrap();
    let idx = index_of(&meta, NAMES[1]);
    let id = e.ensure_file(&with_file(&swarm), idx).await.unwrap();
    assert_eq!(read_all(&e, &id, idx).await, swarm.contents[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_file_rejects_foreign_or_broken_torrent_file_without_leaks() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let foreign = TorrentRef {
        magnet: format!("magnet:?xt=urn:btih:{}", "ab".repeat(20)),
        torrent_file: Some(swarm.swarm.torrent_file.clone()),
    };
    assert!(matches!(
        e.ensure_file(&foreign, 0).await,
        Err(EngineError::Internal(m)) if m == "info-hash mismatch"
    ));
    let broken = TorrentRef {
        magnet: swarm.magnet().to_string(),
        torrent_file: Some(Bytes::from_static(b"garbage")),
    };
    assert!(matches!(
        e.ensure_file(&broken, 0).await,
        Err(EngineError::Internal(m)) if m.contains("invalid torrent file")
    ));
    assert_eq!(e.tracked_torrents(), 0);
    assert!(e.list_torrents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn engine_exposes_torrent_file_of_added_torrents() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    assert!(e.session_torrent_files().is_empty());
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    // Добавили по magnet — движок отдаёт байты, которые можно сохранить.
    let bytes = e.torrent_file(&id).expect("bytes after add by magnet");
    parse_torrent_file(&bytes, Some(&id.0)).unwrap();
    let all = e.session_torrent_files();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, id.0);
    assert!(e
        .torrent_file(&TorrentHandleId(
            nimbus_core::model::InfoHash::parse(&"ef".repeat(20)).unwrap()
        ))
        .is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_metadata_concurrency_is_limited_by_config() {
    let hole = fake_swarm::blackhole().await.unwrap();
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![hole.addr], false);
    cfg.metadata_concurrency = 2;
    cfg.metadata_timeout = Duration::from_millis(300);
    let e = std::sync::Arc::new(TorrentEngine::new(cfg).await.unwrap());

    let started = Instant::now();
    let mut tasks = vec![];
    for _ in 0..5 {
        let e = e.clone();
        let magnet = fake_swarm::deaf_magnet();
        tasks.push(tokio::spawn(async move { e.fetch_metadata(&magnet).await }));
    }
    for t in tasks {
        assert!(matches!(
            t.await.unwrap(),
            Err(EngineError::MetadataTimeout)
        ));
    }
    // 5 запросов по 300 мс при двух слотах — три «волны» (2 + 2 + 1).
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(900),
        "слишком быстро: {took:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn parsing_a_torrent_file_does_not_take_a_metadata_slot() {
    // Движок с одним слотом, занятым «глухим» торрентом: разбор готового файла не ждёт.
    let hole = fake_swarm::blackhole().await.unwrap();
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![hole.addr], false);
    cfg.metadata_concurrency = 1;
    cfg.metadata_timeout = Duration::from_secs(2);
    let e = std::sync::Arc::new(TorrentEngine::new(cfg).await.unwrap());
    let busy = {
        let e = e.clone();
        let magnet = fake_swarm::deaf_magnet();
        tokio::spawn(async move { e.fetch_metadata(&magnet).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let swarm = start_swarm().await;
    let started = Instant::now();
    parse_torrent_file(&swarm.swarm.torrent_file, None).unwrap();
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(matches!(
        busy.await.unwrap(),
        Err(EngineError::MetadataTimeout)
    ));
}

/// Измерение для журнала: от `ensure_file` до первого байта потока — с `.torrent` и без.
#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::print_stderr)]
async fn first_byte_latency_with_and_without_torrent_file() {
    async fn first_byte(e: &TorrentEngine, t: &TorrentRef, idx: usize) -> Duration {
        let started = Instant::now();
        let id = e.ensure_file(t, idx).await.unwrap();
        let mut s = e.open_stream(&id, idx).await.unwrap();
        let mut b = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(30), s.read_exact(&mut b))
            .await
            .unwrap()
            .unwrap();
        started.elapsed()
    }
    let swarm = start_swarm().await;
    let (e1, _b1) = engine(&swarm, false).await;
    let (e2, _b2) = engine(&swarm, false).await;
    let without = first_byte(&e1, &TorrentRef::magnet(swarm.magnet()), 0).await;
    let with = first_byte(&e2, &with_file(&swarm), 0).await;
    eprintln!("first byte: by magnet {without:?}, with .torrent {with:?}");
}

/// Трейт-метод по умолчанию: `ensure_files` через цикл `ensure_file` (так работают фейки).
struct Recorder(std::sync::Mutex<Vec<usize>>);

#[async_trait::async_trait]
impl FileProvider for Recorder {
    async fn ensure_file(&self, _: &TorrentRef, i: usize) -> Result<TorrentHandleId, EngineError> {
        self.0.lock().unwrap().push(i);
        Ok(TorrentHandleId(
            nimbus_core::model::InfoHash::parse(&"ab".repeat(20)).unwrap(),
        ))
    }
    async fn open_stream(
        &self,
        _: &TorrentHandleId,
        _: usize,
    ) -> Result<Box<dyn AsyncReadSeek + Send + Unpin>, EngineError> {
        Err(EngineError::NotFound)
    }
    fn file_progress(&self, _: &TorrentHandleId, _: usize) -> Option<FileProgress> {
        None
    }
    fn file_path(&self, _: &TorrentHandleId, _: usize) -> Option<std::path::PathBuf> {
        None
    }
}

#[tokio::test]
async fn default_ensure_files_loops_over_ensure_file() {
    let r = Recorder(Default::default());
    r.ensure_files(&TorrentRef::magnet("m"), &[3, 1, 2])
        .await
        .unwrap();
    assert_eq!(*r.0.lock().unwrap(), [3, 1, 2]);
    assert!(matches!(
        r.ensure_files(&TorrentRef::magnet("m"), &[]).await,
        Err(EngineError::Internal(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_resume_and_release_work_through_the_provider_trait() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let files: &dyn FileProvider = &e;
    let id = files
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[0, 1])
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Seeding).await;

    files.pause_torrent(&id).await.unwrap();
    assert_eq!(state_of(&e, &id), Some(TorrentState::Paused));
    files.resume_torrent(&id).await.unwrap();
    wait_state(&e, &id, TorrentState::Seeding).await;
    files.release_file(&id, 0, false).await.unwrap();
    assert_eq!(e.selected_files(&id).await, [1]);
    let unknown = TorrentHandleId(nimbus_core::model::InfoHash::parse(&"ab".repeat(20)).unwrap());
    assert!(matches!(
        files.release_file(&unknown, 0, true).await,
        Err(EngineError::NotFound)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn release_with_delete_tolerates_a_missing_file_and_reports_other_errors() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_files(&TorrentRef::magnet(swarm.magnet()), &[0, 1, 2])
        .await
        .unwrap();
    for i in 0..3 {
        wait_finished(&e, &id, i).await;
    }
    // Файла уже нет — удаление данных не ошибка.
    let p0 = e.file_path(&id, 0).unwrap();
    std::fs::remove_file(&p0).unwrap();
    e.release_file(&id, 0, true).await.unwrap();
    // На месте файла каталог: `remove_file` падает не с NotFound → Storage.
    let p1 = e.file_path(&id, 1).unwrap();
    std::fs::remove_file(&p1).unwrap();
    std::fs::create_dir(&p1).unwrap();
    assert!(matches!(
        e.release_file(&id, 1, true).await,
        Err(EngineError::Storage(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn seeding_and_ratio_setters_are_idempotent() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), 0)
        .await
        .unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Seeding).await;
    e.set_seeding(true).await; // уже включено — ничего не меняется
    e.set_seed_ratio(None).await; // уже None
    assert!(e.seeding());
    assert_eq!(state_of(&e, &id), Some(TorrentState::Seeding));
}

#[tokio::test(flavor = "multi_thread")]
async fn dht_with_persistence_starts_and_stops_cleanly() {
    let base = tempdir();
    let mut cfg = base_cfg(base.path(), vec![], true);
    cfg.dht = true;
    cfg.persistence = true;
    let e = TorrentEngine::new(cfg).await.unwrap();
    assert!(e.listen_addr().is_some());
    e.shutdown().await;
}

/// Файл данных — симлинк на `/dev/full`: открывается и пишется, но каждая запись даёт ENOSPC.
/// Торрент живёт, получает данные и падает в `Error` (отказ диска посреди загрузки).
async fn engine_with_errored_torrent(
    swarm: &Swarm,
) -> (
    TorrentEngine,
    TempDir,
    TorrentHandleId,
    usize,
    std::path::PathBuf,
) {
    let (e, base) = engine(swarm, true).await;
    let one = ix(&e, swarm).await[1];
    let data = base.path().join("torrents").join("Album");
    let _ = std::fs::create_dir_all(&data);
    let link = data.join(NAMES[1]);
    std::os::unix::fs::symlink("/dev/full", &link).unwrap();
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), one)
        .await
        .unwrap();
    let id = TorrentHandleId(nimbus_core::model::InfoHash::parse(&swarm.swarm.info_hash).unwrap());
    wait_state(&e, &id, TorrentState::Error).await;
    (e, base, id, one, link)
}

#[tokio::test(flavor = "multi_thread")]
async fn errored_torrent_is_restarted_when_the_cause_is_gone() {
    let swarm = start_swarm().await;
    let (e, _base, id, one, link) = engine_with_errored_torrent(&swarm).await;
    std::fs::remove_file(&link).unwrap(); // диск «починили»
    let again = e
        .ensure_file(&TorrentRef::magnet(swarm.magnet()), one)
        .await
        .unwrap();
    assert_eq!(again, id);
    assert_eq!(read_all(&e, &id, one).await, swarm.contents[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn errored_torrent_that_cannot_recover_is_readded_instead_of_left_dead() {
    let swarm = start_swarm().await;
    let (e, _base, id, one, _link) = engine_with_errored_torrent(&swarm).await;
    // Причина осталась: перезапуск не помогает, торрент удаляется и добавляется заново (свежий
    // дескриптор), а не остаётся мёртвым в сессии. Диск всё ещё «полный» — он снова упадёт.
    e.ensure_file(&TorrentRef::magnet(swarm.magnet()), one)
        .await
        .unwrap();
    assert_eq!(e.list_torrents().len(), 1);
    wait_state(&e, &id, TorrentState::Error).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_file_resumes_a_paused_unfinished_torrent_without_changing_selection() {
    let swarm = start_swarm().await;
    // Пиров нет: торрент добавляется по готовому `.torrent` и не может завершиться.
    let base = tempdir();
    let e = TorrentEngine::new(base_cfg(base.path(), vec![], true))
        .await
        .unwrap();
    let t = TorrentRef::new(swarm.magnet(), Some(swarm.swarm.torrent_file.to_vec()));
    let id = e.ensure_file(&t, 0).await.unwrap();
    e.pause_torrent(&id).await.unwrap();
    assert_eq!(state_of(&e, &id), Some(TorrentState::Paused));
    // Тот же файл, выбор не меняется, но он не докачан → торрент снимается с паузы.
    e.ensure_file(&t, 0).await.unwrap();
    assert_ne!(state_of(&e, &id), Some(TorrentState::Paused));
    assert_eq!(e.selected_files(&id).await, [0]);
}
