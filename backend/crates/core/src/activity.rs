//! Учёт файлов, которые сейчас используются: стримы и недавний prefetch.
//! Вытеснение кэша (`EvictCache`) такие файлы не удаляет.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Как долго после prefetch файл защищён от вытеснения.
pub const PREFETCH_PROTECT: Duration = Duration::from_secs(10 * 60);

pub type FileKey = (i64, i32);

#[derive(Default)]
struct Inner {
    streams: HashMap<FileKey, usize>,
    prefetched: HashMap<FileKey, Instant>,
}

#[derive(Clone, Default)]
pub struct Activity(Arc<Mutex<Inner>>);

/// Пока жив, файл считается играющим.
pub struct StreamGuard {
    activity: Activity,
    key: FileKey,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let mut g = self.activity.0.lock().expect("activity lock");
        if let Some(n) = g.streams.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                g.streams.remove(&self.key);
            }
        }
    }
}

impl Activity {
    pub fn begin_stream(&self, torrent_id: i64, file_index: i32) -> StreamGuard {
        let key = (torrent_id, file_index);
        *self
            .0
            .lock()
            .expect("activity lock")
            .streams
            .entry(key)
            .or_default() += 1;
        StreamGuard {
            activity: self.clone(),
            key,
        }
    }

    pub fn mark_prefetched(&self, torrent_id: i64, file_index: i32) {
        self.0
            .lock()
            .expect("activity lock")
            .prefetched
            .insert((torrent_id, file_index), Instant::now());
    }

    /// Файл сейчас стримится или был предзагружен меньше `PREFETCH_PROTECT` назад.
    pub fn is_protected(&self, torrent_id: i64, file_index: i32) -> bool {
        let mut g = self.0.lock().expect("activity lock");
        let key = (torrent_id, file_index);
        if g.streams.contains_key(&key) {
            return true;
        }
        g.prefetched.retain(|_, at| at.elapsed() < PREFETCH_PROTECT);
        g.prefetched.contains_key(&key)
    }

    pub fn active_streams(&self) -> usize {
        self.0.lock().expect("activity lock").streams.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_guard_counts_and_releases() {
        let a = Activity::default();
        let g1 = a.begin_stream(1, 0);
        let g2 = a.begin_stream(1, 0);
        assert!(a.is_protected(1, 0));
        drop(g1);
        assert!(a.is_protected(1, 0));
        drop(g2);
        assert!(!a.is_protected(1, 0));
        assert_eq!(a.active_streams(), 0);
    }

    #[test]
    fn prefetch_protects() {
        let a = Activity::default();
        a.mark_prefetched(2, 3);
        assert!(a.is_protected(2, 3) && !a.is_protected(2, 4));
    }
}
