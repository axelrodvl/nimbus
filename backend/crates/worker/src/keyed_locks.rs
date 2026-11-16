//! Блокировки по ключу: не больше одного владельца на ключ, пока остальные ждут.
//! И паузы по ключу ([`Cooldowns`]): «до такого-то момента ключ не трогать».

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Карта «ключ → асинхронный мьютекс». Глобальный мьютекс карты берётся только на доступ к ней
/// и никогда не держится через `.await`; запись удаляется, когда на неё больше никто не ссылается.
#[derive(Default)]
pub struct KeyedLocks {
    map: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
}

/// Владение ключом; освобождается при drop. Если ожидание отменено (drop до получения
/// блокировки), запись карты всё равно убирается.
pub struct KeyGuard {
    locks: Arc<KeyedLocks>,
    key: i64,
    entry: Arc<tokio::sync::Mutex<()>>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl KeyedLocks {
    /// Ждёт своей очереди на ключе `key`.
    pub async fn lock(self: &Arc<Self>, key: i64) -> KeyGuard {
        let entry = self
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_default()
            .clone();
        // Страж создаётся до ожидания: отмена `lock` не оставит запись в карте.
        let mut g = KeyGuard {
            locks: self.clone(),
            key,
            entry: entry.clone(),
            guard: None,
        };
        g.guard = Some(entry.lock_owned().await);
        g
    }

    /// Сколько ключей сейчас в карте (для тестов).
    pub fn len(&self) -> usize {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for KeyGuard {
    fn drop(&mut self) {
        self.guard.take();
        let mut map = self
            .locks
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Ссылки: карта + наш `entry`; больше — значит, кто-то ещё ждёт этот ключ.
        if Arc::strong_count(&self.entry) <= 2 {
            map.remove(&self.key);
        }
    }
}

/// Паузы по ключу в памяти процесса. После рестарта пусто — это безопасно: пауза лишь бережёт
/// попытки, а отложенные задачи и так вернутся не раньше своего `run_after`.
#[derive(Default)]
pub struct Cooldowns {
    map: Mutex<HashMap<i64, Instant>>,
}

impl Cooldowns {
    /// Начинает паузу ключа `key` длиной `pause` (истёкшие записи других ключей убираются).
    pub fn start(&self, key: i64, pause: Duration) {
        let now = Instant::now();
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        map.retain(|_, until| *until > now);
        map.insert(key, now + pause);
    }

    /// Сколько осталось до конца паузы; `None` — паузы нет или она прошла.
    pub fn remaining(&self, key: i64) -> Option<Duration> {
        let until = *self
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)?;
        until
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
    }

    /// Снимает паузу ключа.
    pub fn clear(&self, key: i64) {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn cooldown_counts_down_expires_and_clears() {
        let c = Cooldowns::default();
        assert_eq!(c.remaining(1), None);
        c.start(1, Duration::from_secs(60));
        c.start(2, Duration::ZERO);
        let left = c.remaining(1).unwrap();
        assert!(left <= Duration::from_secs(60) && left > Duration::from_secs(58));
        assert_eq!(c.remaining(2), None, "истёкшая пауза не действует");
        // Новая пауза убирает истёкшие записи.
        c.start(3, Duration::from_secs(1));
        assert!(!c.map.lock().unwrap().contains_key(&2));
        c.clear(1);
        assert_eq!(c.remaining(1), None);
    }

    #[tokio::test]
    async fn serializes_same_key_and_cleans_up() {
        let locks = Arc::new(KeyedLocks::default());
        let inside = Arc::new(AtomicU32::new(0));
        let mut tasks = vec![];
        for _ in 0..8 {
            let (locks, inside) = (locks.clone(), inside.clone());
            tasks.push(tokio::spawn(async move {
                let _g = locks.lock(7).await;
                assert_eq!(
                    inside.fetch_add(1, Ordering::SeqCst),
                    0,
                    "двое под одним ключом"
                );
                tokio::time::sleep(Duration::from_millis(2)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert!(locks.is_empty());
    }

    #[tokio::test]
    async fn different_keys_do_not_block_and_cancelled_wait_leaves_no_entry() {
        let locks = Arc::new(KeyedLocks::default());
        let a = locks.lock(1).await;
        let _b = locks.lock(2).await;
        // ожидание занятого ключа отменяется по таймауту
        assert!(
            tokio::time::timeout(Duration::from_millis(20), locks.lock(1))
                .await
                .is_err()
        );
        drop(a);
        assert_eq!(locks.len(), 1, "остался только ключ 2");
    }
}
