// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Умолчания трейта `FileProvider`: реализация, которой нужны только обязательные методы.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use nimbus_core::model::InfoHash;
use nimbus_torrent::{
    AsyncReadSeek, EngineError, FileProgress, FileProvider, TorrentHandleId, TorrentRef,
};

#[derive(Default)]
struct Minimal {
    ensured: AtomicUsize,
}

#[async_trait]
impl FileProvider for Minimal {
    async fn ensure_file(&self, _: &TorrentRef, _: usize) -> Result<TorrentHandleId, EngineError> {
        self.ensured.fetch_add(1, Ordering::SeqCst);
        Ok(id())
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
    fn file_path(&self, _: &TorrentHandleId, _: usize) -> Option<PathBuf> {
        None
    }
}

fn id() -> TorrentHandleId {
    TorrentHandleId(InfoHash::parse(&"01".repeat(20)).unwrap())
}

#[tokio::test]
async fn default_methods_are_harmless_noops() {
    let p = Minimal::default();
    assert!(p.torrent_file(&id()).is_none());
    p.pause_torrent(&id()).await.unwrap();
    p.resume_torrent(&id()).await.unwrap();
    p.release_file(&id(), 3, true).await.unwrap();
}

#[tokio::test]
async fn default_ensure_files_calls_ensure_file_for_each_index_and_rejects_empty() {
    let p = Minimal::default();
    let t = TorrentRef::magnet(format!("magnet:?xt=urn:btih:{}", "01".repeat(20)));
    assert_eq!(p.ensure_files(&t, &[0, 4, 9]).await.unwrap(), id());
    assert_eq!(p.ensured.load(Ordering::SeqCst), 3);
    assert!(matches!(
        p.ensure_files(&t, &[]).await,
        Err(EngineError::Internal(_))
    ));
}
