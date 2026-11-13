use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

/// Лимитер провайдера: не чаще одного запроса за `min_interval` **и** не больше `max_concurrent`
/// запросов одновременно. Темп считается по `tokio::time`, поэтому тестируется через `pause()`.
pub struct Limiter {
    min_interval: Duration,
    /// Момент, раньше которого следующий запрос стартовать нельзя.
    next_slot: Mutex<Instant>,
    slots: Arc<Semaphore>,
}

/// Удерживается на время HTTP-запроса: пока жив, занимает одно из `max_concurrent` мест.
#[must_use = "место освобождается при drop — держите guard до конца запроса"]
pub struct Permit(#[allow(dead_code)] OwnedSemaphorePermit);

/// apibay: публичный JSON-API без ключа, выдерживает частые запросы; 4 параллельных — запас,
/// после которого CDN начинает отвечать 429.
pub const TPB_INTERVAL: Duration = Duration::from_millis(250);
pub const TPB_CONCURRENCY: usize = 4;
/// Собственный индексер (Prowlarr/Jackett) стоит у пользователя дома и ограничивается им самим:
/// ограничиваем лишь собственную нагрузку на него.
pub const TORZNAB_INTERVAL: Duration = Duration::from_millis(100);
pub const TORZNAB_CONCURRENCY: usize = 8;
/// RuTracker банит за напор (капча/блокировка аккаунта), поэтому темп и параллелизм — не снижать.
pub const RUTRACKER_INTERVAL: Duration = Duration::from_secs(1);
pub const RUTRACKER_CONCURRENCY: usize = 2;

impl Limiter {
    pub fn new(min_interval: Duration, max_concurrent: usize) -> Self {
        Self {
            min_interval,
            next_slot: Mutex::new(Instant::now()),
            slots: Arc::new(Semaphore::new(max_concurrent.max(1))),
        }
    }

    /// Ждёт место и свой момент старта. Отмена (drop будущего) место не занимает.
    pub async fn acquire(&self) -> Permit {
        // Семафор закрывается только вместе с лимитером, которого здесь нет — `acquire_owned` не падает.
        let permit = Arc::clone(&self.slots)
            .acquire_owned()
            .await
            .expect("limiter semaphore is never closed");
        let start = {
            let mut next = self
                .next_slot
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let start = (*next).max(Instant::now());
            *next = start + self.min_interval;
            start
        };
        tokio::time::sleep_until(start).await;
        Permit(permit)
    }
}
