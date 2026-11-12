use std::time::Duration;

use governor::{clock::DefaultClock, state::InMemoryState, state::NotKeyed, Quota, RateLimiter};

/// Лимитер «1 запрос / interval» на провайдера.
pub struct Limiter(RateLimiter<NotKeyed, InMemoryState, DefaultClock>);

pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
/// Для apibay и собственного Torznab-индексера (Prowlarr/Jackett) хватает более частых запросов.
pub const FAST_INTERVAL: Duration = Duration::from_millis(500);

impl Limiter {
    pub fn new(interval: Duration) -> Self {
        let interval = interval.max(Duration::from_millis(1));
        Self(RateLimiter::direct(
            Quota::with_period(interval).expect("non-zero period"),
        ))
    }

    pub async fn wait(&self) {
        self.0.until_ready().await;
    }
}
