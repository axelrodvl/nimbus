use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;

use crate::client::Priority;

/// Общий лимитер «не чаще одного запроса за `interval`» с приоритетом интерактивных запросов.
///
/// Каждый ожидающий пытается занять ближайший свободный слот; фоновые запросы перед каждой
/// попыткой уступают, пока есть ожидающие интерактивные.
pub(crate) struct Limiter {
    interval: Duration,
    next: Mutex<Instant>,
    interactive_waiting: AtomicUsize,
}

struct WaitGuard<'a>(&'a AtomicUsize);

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Limiter {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            next: Mutex::new(Instant::now()),
            interactive_waiting: AtomicUsize::new(0),
        }
    }

    pub(crate) async fn acquire(&self, priority: Priority) {
        let _guard = match priority {
            Priority::Interactive => {
                self.interactive_waiting.fetch_add(1, Ordering::SeqCst);
                Some(WaitGuard(&self.interactive_waiting))
            }
            Priority::Background => None,
        };
        loop {
            if priority == Priority::Background
                && self.interactive_waiting.load(Ordering::SeqCst) > 0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
            let wait_until = {
                let mut next = self
                    .next
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let now = Instant::now();
                if *next <= now {
                    *next = now + self.interval;
                    return;
                }
                *next
            };
            tokio::time::sleep_until(wait_until).await;
        }
    }
}
