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

    let id = e.ensure_file(swarm.magnet(), idx).await.unwrap();
    assert_eq!(e.selected_files(&id).await, [idx]);
    assert_eq!(e.ensure_file(swarm.magnet(), idx).await.unwrap(), id);

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

    let id = e.ensure_file(swarm.magnet(), a).await.unwrap();
    wait_finished(&e, &id, a).await;
    wait_state(&e, &id, TorrentState::Paused).await;

    // Второй файл — набор объединяется, торрент снимается с паузы и докачивает.
    e.ensure_file(swarm.magnet(), b).await.unwrap();
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
        tokio::spawn(async move { e.ensure_file(&deaf, 0).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await; // глухой уже держит свой слот

    let first = ix(&e, &swarm).await[0];
    let live = Instant::now();
    let id = e.ensure_file(swarm.magnet(), first).await.unwrap();
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
        e.ensure_file(&deaf, 0).await,
        Err(EngineError::MetadataTimeout)
    ));
    assert!(
        e.list_torrents().is_empty(),
        "торрент не должен остаться в сессии"
    );
    assert_eq!(e.tracked_torrents(), 0, "слот должен быть убран");
    // Движок работоспособен: живой торрент добавляется как обычно.
    e.ensure_file(swarm.magnet(), 0).await.unwrap();
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
        tasks.push(tokio::spawn(async move { e.ensure_file(&magnet, i).await }));
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
    let id = e.ensure_file(swarm.magnet(), 1).await.unwrap();
    let t = Instant::now();
    for _ in 0..20 {
        assert_eq!(e.ensure_file(swarm.magnet(), 1).await.unwrap(), id);
    }
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    assert_eq!(e.selected_files(&id).await, [1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_file_index_for_new_torrent_removes_it_from_session() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    assert!(matches!(
        e.ensure_file(swarm.magnet(), 99).await,
        Err(EngineError::InvalidFileIndex(99))
    ));
    assert!(e.list_torrents().is_empty());
    assert_eq!(e.tracked_torrents(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_file_index_for_added_torrent_keeps_it() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
    assert!(matches!(
        e.ensure_file(swarm.magnet(), 99).await,
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
        e.ensure_files(swarm.magnet(), &[]).await,
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
        .ensure_files(swarm.magnet(), &[ix[0], ix[2]])
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
    e.ensure_files(swarm.magnet(), &[ix[1], ix[2]])
        .await
        .unwrap();
    assert_eq!(e.selected_files(&id).await, [0, 1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn release_file_shrinks_selection_and_removes_last_torrent() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, true).await;
    let id = e.ensure_files(swarm.magnet(), &[0, 1]).await.unwrap();
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
    let id = e.ensure_files(swarm.magnet(), &[0, 1]).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), ix[0]).await.unwrap();
    wait_finished(&e, &id, ix[0]).await;
    // seeding = false: после завершения — пауза.
    wait_state(&e, &id, TorrentState::Paused).await;

    e.set_seeding(true).await;
    wait_state(&e, &id, TorrentState::Seeding).await;
    e.set_seeding(false).await;
    wait_state(&e, &id, TorrentState::Paused).await;

    // Новый файл в завершённом торренте на паузе → возобновляется и докачивает.
    e.ensure_file(swarm.magnet(), ix[2]).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
    e.ensure_file(swarm.magnet(), 1).await.unwrap();
    e.ensure_file(swarm.magnet(), 2).await.unwrap();
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
    let id = e.ensure_file(swarm.magnet(), one).await.unwrap();
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
    e.ensure_file(swarm.magnet(), 0).await.unwrap();
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
    // Находим свободный порт и освобождаем его перед стартом движка.
    let probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
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
    let err = e.ensure_file(swarm.magnet(), 0).await.unwrap_err();
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
    let id = files.ensure_file(swarm.magnet(), ix[0]).await.unwrap();
    let same = files
        .ensure_files(swarm.magnet(), &[ix[0], ix[1]])
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
    e.ensure_file(swarm.magnet(), 0).await.unwrap();
    // Сидер остановлен: метаданные берутся из сессии.
    swarm.swarm.stop().await;
    let meta = e.fetch_metadata(swarm.magnet()).await.unwrap();
    assert_eq!(meta.files.len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_file_on_finished_paused_torrent_keeps_it_paused() {
    let swarm = start_swarm().await;
    let (e, _base) = engine(&swarm, false).await;
    let id = e.ensure_file(swarm.magnet(), 0).await.unwrap();
    wait_finished(&e, &id, 0).await;
    wait_state(&e, &id, TorrentState::Paused).await;
    // Файл уже скачан: повторный запрос не возобновляет торрент.
    e.ensure_file(swarm.magnet(), 0).await.unwrap();
    assert_eq!(state_of(&e, &id), Some(TorrentState::Paused));
}

/// Трейт-метод по умолчанию: `ensure_files` через цикл `ensure_file` (так работают фейки).
struct Recorder(std::sync::Mutex<Vec<usize>>);

#[async_trait::async_trait]
impl FileProvider for Recorder {
    async fn ensure_file(&self, _: &str, i: usize) -> Result<TorrentHandleId, EngineError> {
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
    r.ensure_files("m", &[3, 1, 2]).await.unwrap();
    assert_eq!(*r.0.lock().unwrap(), [3, 1, 2]);
    assert!(matches!(
        r.ensure_files("m", &[]).await,
        Err(EngineError::Internal(_))
    ));
}
