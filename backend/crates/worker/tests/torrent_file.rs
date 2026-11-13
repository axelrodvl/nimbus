// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Дозаполнение `.torrent` из сессии движка и сборка `TorrentRef` из БД.

use nimbus_core::model::*;
use nimbus_db::repo::torrents;
use nimbus_torrent::{Bytes, TorrentRef};
use nimbus_worker::torrent_file::{fill_torrent_files, torrent_ref};
use sqlx::PgPool;

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{n:02x}").repeat(20)).unwrap()
}

async fn torrent(pool: &PgPool, n: u8) -> Torrent {
    torrents::upsert_by_info_hash(
        pool,
        &NewTorrent {
            info_hash: hash(n),
            magnet: format!("magnet:?xt=urn:btih:{}", hash(n)),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: format!("t{n}"),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn backfill_fills_only_missing_files_of_known_torrents(pool: PgPool) {
    let empty = torrent(&pool, 1).await;
    let full = torrent(&pool, 2).await;
    torrents::set_torrent_file(&pool, full.id, b"old")
        .await
        .unwrap();

    let filled = fill_torrent_files(
        &pool,
        vec![
            (hash(1), Bytes::from_static(b"one")),
            (hash(2), Bytes::from_static(b"two")),
            (hash(3), Bytes::from_static(b"unknown torrent")),
        ],
    )
    .await;

    assert_eq!(filled, 1);
    assert_eq!(
        torrents::torrent_file(&pool, empty.id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"one"[..])
    );
    assert_eq!(
        torrents::torrent_file(&pool, full.id)
            .await
            .unwrap()
            .as_deref(),
        Some(&b"old"[..])
    );
    // Повторный запуск ничего не меняет.
    assert_eq!(
        fill_torrent_files(&pool, vec![(hash(1), Bytes::from_static(b"again"))]).await,
        0
    );
    assert_eq!(fill_torrent_files(&pool, vec![]).await, 0);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn backfill_survives_a_database_error(pool: PgPool) {
    torrent(&pool, 1).await;
    let closed = pool.clone();
    closed.close().await;
    // Ошибка БД логируется и не паникует; ничего не записано.
    assert_eq!(
        fill_torrent_files(&pool, vec![(hash(1), Bytes::from_static(b"x"))]).await,
        0
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn torrent_ref_reads_the_file_only_when_the_flag_is_set(pool: PgPool) {
    let t = torrent(&pool, 1).await;
    let r = torrent_ref(&pool, &t).await.unwrap();
    assert_eq!(r, TorrentRef::magnet(t.magnet.clone()));

    torrents::set_torrent_file(&pool, t.id, b"bytes")
        .await
        .unwrap();
    // Устаревшая копия без флага файл не читает; свежая — читает.
    assert_eq!(torrent_ref(&pool, &t).await.unwrap().torrent_file, None);
    let fresh = torrents::get(&pool, t.id).await.unwrap().unwrap();
    let r = torrent_ref(&pool, &fresh).await.unwrap();
    assert_eq!(r.torrent_file.as_deref(), Some(&b"bytes"[..]));
    assert_eq!(r.magnet, fresh.magnet);
}
