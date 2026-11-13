use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

use crate::client::Priority;

/// Нижняя граница адаптивного темпа (запросов в секунду).
const MIN_ADAPTIVE_RATE: f64 = 0.2;
/// Сколько успешных запросов нужно для одного шага восстановления темпа.
const RECOVERY_EVERY: u32 = 30;
/// Темп, с которого начинается снижение, если лимит не задан (`rate = 0`).
const UNLIMITED_FALLBACK_RATE: f64 = 4.0;
/// Темп выше этого значения считается «без ограничения» при восстановлении.
const UNLIMITED_ABOVE: f64 = 100.0;

/// Лимиты клиента MusicBrainz.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MbLimits {
    /// Запросов в секунду; `0` — без ограничения темпа.
    pub rate_per_sec: f64,
    /// Размер «ведра»: сколько запросов подряд проходят без ожидания.
    pub burst: u8,
    /// Одновременных HTTP-запросов.
    pub max_concurrent: u8,
}

impl MbLimits {
    /// Правила публичного сервера: 1 запрос/с, короткий burst под интерактивный поиск.
    pub const fn public() -> Self {
        Self {
            rate_per_sec: 1.0,
            burst: 3,
            max_concurrent: 2,
        }
    }

    /// Без ограничения темпа (свой сервер, тесты).
    pub const fn unlimited(max_concurrent: u8) -> Self {
        Self {
            rate_per_sec: 0.0,
            burst: 1,
            max_concurrent,
        }
    }

    /// Только темп с «ведром» на один запрос (тесты на интервалы).
    pub const fn paced(rate_per_sec: f64) -> Self {
        Self {
            rate_per_sec,
            burst: 1,
            max_concurrent: 1,
        }
    }
}

impl From<&nimbus_core::settings::MusicbrainzSettings> for MbLimits {
    /// Берёт уже **эффективные** значения (`effective()`) — вызывающий отвечает за выбор профиля.
    fn from(s: &nimbus_core::settings::MusicbrainzSettings) -> Self {
        Self {
            rate_per_sec: s.rate_per_sec,
            burst: s.burst,
            max_concurrent: s.max_concurrent,
        }
    }
}

struct State {
    /// Заданный пользователем темп (`0` — без ограничения).
    ceiling: f64,
    /// Текущий темп с учётом адаптации (`INFINITY` — без ограничения).
    rate: f64,
    burst: f64,
    tokens: f64,
    last_refill: Instant,
    /// До этого момента запросы не выдаются (`Retry-After`).
    blocked_until: Option<Instant>,
    successes: u32,
}

impl State {
    fn refill(&mut self, now: Instant) {
        if self.rate.is_finite() {
            let dt = now
                .saturating_duration_since(self.last_refill)
                .as_secs_f64();
            self.tokens = (self.tokens + dt * self.rate).min(self.burst);
        } else {
            self.tokens = self.burst;
        }
        self.last_refill = now;
    }
}

/// Лимитер: token bucket (темп + burst), семафор на параллелизм, приоритет интерактивных
/// запросов и адаптация темпа к 503/429.
///
/// Фоновый запрос не берёт токен, пока ждёт хотя бы один интерактивный, и никогда не берёт
/// последний токен ведра (он остаётся интерактивным). Ожидание — на `Notify` и таймере, без опроса.
pub(crate) struct Limiter {
    state: Mutex<State>,
    wake: Notify,
    slots: Arc<Semaphore>,
    max_concurrent: usize,
    interactive_waiting: AtomicUsize,
    /// Сколько раз ожидающий просыпался (для теста «нет busy-loop»).
    wakeups: AtomicUsize,
}

/// Разрешение на один HTTP-запрос; слот параллелизма освобождается при `drop`.
pub(crate) struct Permit {
    _slot: OwnedSemaphorePermit,
}

struct WaitGuard<'a>(&'a Limiter);

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        self.0.interactive_waiting.fetch_sub(1, Ordering::SeqCst);
        // Фоновые ожидающие могли ждать именно этого.
        self.0.wake.notify_waiters();
    }
}

impl Limiter {
    pub(crate) fn new(limits: MbLimits) -> Self {
        let burst = f64::from(limits.burst.max(1));
        let ceiling = if limits.rate_per_sec > 0.0 {
            limits.rate_per_sec
        } else {
            0.0
        };
        let max_concurrent = usize::from(limits.max_concurrent.max(1));
        Self {
            state: Mutex::new(State {
                ceiling,
                rate: if ceiling > 0.0 {
                    ceiling
                } else {
                    f64::INFINITY
                },
                burst,
                tokens: burst,
                last_refill: Instant::now(),
                blocked_until: None,
                successes: 0,
            }),
            wake: Notify::new(),
            slots: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            interactive_waiting: AtomicUsize::new(0),
            wakeups: AtomicUsize::new(0),
        }
    }

    pub(crate) fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ждёт токен и слот параллелизма.
    pub(crate) async fn acquire(&self, priority: Priority) -> Permit {
        let _guard = (priority == Priority::Interactive).then(|| {
            self.interactive_waiting.fetch_add(1, Ordering::SeqCst);
            WaitGuard(self)
        });
        loop {
            // Подписка до проверки состояния: событие между проверкой и ожиданием не теряется.
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let wait = match self.try_take(priority) {
                Ok(()) => break,
                Err(wait) => wait,
            };
            match wait {
                Some(d) => {
                    tokio::select! {
                        () = tokio::time::sleep(d) => {}
                        () = &mut notified => {}
                    }
                }
                None => notified.await,
            }
            self.wakeups.fetch_add(1, Ordering::SeqCst);
        }
        // Семафор никогда не закрывается: `Limiter` его не закрывает.
        let slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .expect("limiter semaphore is never closed");
        Permit { _slot: slot }
    }

    /// `Ok` — токен взят; `Err(Some(d))` — повторить через `d`; `Err(None)` — ждать события.
    fn try_take(&self, priority: Priority) -> Result<(), Option<Duration>> {
        let background = priority == Priority::Background;
        if background && self.interactive_waiting.load(Ordering::SeqCst) > 0 {
            return Err(None);
        }
        let mut st = self.state();
        let now = Instant::now();
        if let Some(until) = st.blocked_until {
            if until > now {
                return Err(Some(until - now));
            }
            st.blocked_until = None;
        }
        st.refill(now);
        if !st.rate.is_finite() {
            return Ok(());
        }
        // Фоновый оставляет в ведре последний токен; при burst = 1 резерв невозможен.
        let need = if background { st.burst.min(2.0) } else { 1.0 };
        if st.tokens >= need {
            st.tokens -= 1.0;
            return Ok(());
        }
        let secs = (need - st.tokens) / st.rate;
        Err(Some(
            Duration::from_secs_f64(secs.max(0.0)).max(Duration::from_millis(1)),
        ))
    }

    /// Ответ 503/429: темп ×0.5 (не ниже `MIN_ADAPTIVE_RATE`), ведро пустое, `retry_after` —
    /// пауза для всех запросов.
    pub(crate) fn on_throttled(&self, retry_after: Option<Duration>) {
        {
            let mut st = self.state();
            let now = Instant::now();
            let floor = MIN_ADAPTIVE_RATE.min(if st.ceiling > 0.0 {
                st.ceiling
            } else {
                f64::MAX
            });
            let base = if st.rate.is_finite() {
                st.rate
            } else {
                UNLIMITED_FALLBACK_RATE * 2.0
            };
            st.rate = (base * 0.5).max(floor);
            st.tokens = 0.0;
            st.last_refill = now;
            st.successes = 0;
            if let Some(d) = retry_after.filter(|d| !d.is_zero()) {
                let until = now + d;
                st.blocked_until = Some(st.blocked_until.map_or(until, |b| b.max(until)));
            }
        }
        self.wake.notify_waiters();
    }

    /// Успешный запрос: каждые `RECOVERY_EVERY` успехов темп растёт ×1.25 до заданного.
    pub(crate) fn on_success(&self) {
        let mut st = self.state();
        st.successes += 1;
        if st.successes < RECOVERY_EVERY {
            return;
        }
        st.successes = 0;
        if st.ceiling > 0.0 {
            if st.rate < st.ceiling {
                st.rate = (st.rate * 1.25).min(st.ceiling);
            }
        } else if st.rate.is_finite() {
            let next = st.rate * 1.25;
            st.rate = if next > UNLIMITED_ABOVE {
                f64::INFINITY
            } else {
                next
            };
        }
    }

    /// Текущий темп (`None` — без ограничения).
    #[cfg(test)]
    fn current_rate(&self) -> Option<f64> {
        let r = self.state().rate;
        r.is_finite().then_some(r)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    const SEC: Duration = Duration::from_secs(1);

    fn limiter(rate: f64, burst: u8, conc: u8) -> Arc<Limiter> {
        Arc::new(Limiter::new(MbLimits {
            rate_per_sec: rate,
            burst,
            max_concurrent: conc,
        }))
    }

    async fn elapsed_of(l: &Limiter, p: Priority) -> Duration {
        let t = Instant::now();
        drop(l.acquire(p).await);
        t.elapsed()
    }

    #[tokio::test(start_paused = true)]
    async fn burst_passes_without_waiting_then_paces() {
        let l = limiter(1.0, 3, 8);
        for _ in 0..3 {
            assert_eq!(elapsed_of(&l, Priority::Interactive).await, Duration::ZERO);
        }
        let e = elapsed_of(&l, Priority::Interactive).await;
        assert!(
            e >= SEC - Duration::from_millis(5) && e <= SEC + Duration::from_millis(50),
            "{e:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bucket_refills_while_idle_up_to_burst() {
        let l = limiter(1.0, 3, 8);
        for _ in 0..3 {
            drop(l.acquire(Priority::Interactive).await);
        }
        tokio::time::advance(Duration::from_secs(60)).await;
        for _ in 0..3 {
            assert_eq!(elapsed_of(&l, Priority::Interactive).await, Duration::ZERO);
        }
        assert!(elapsed_of(&l, Priority::Interactive).await >= Duration::from_millis(900));
    }

    #[tokio::test(start_paused = true)]
    async fn zero_rate_never_waits() {
        let l = limiter(0.0, 1, 8);
        for _ in 0..50 {
            assert_eq!(elapsed_of(&l, Priority::Background).await, Duration::ZERO);
        }
        assert_eq!(l.current_rate(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn max_concurrent_caps_in_flight_requests() {
        let l = limiter(0.0, 1, 2);
        let a = l.acquire(Priority::Interactive).await;
        let _b = l.acquire(Priority::Interactive).await;
        let third_done = Arc::new(AtomicBool::new(false));
        let (l2, flag) = (l.clone(), third_done.clone());
        let h = tokio::spawn(async move {
            let _p = l2.acquire(Priority::Interactive).await;
            flag.store(true, Ordering::SeqCst);
        });
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        assert!(
            !third_done.load(Ordering::SeqCst),
            "третий запрос должен ждать слот"
        );
        drop(a);
        h.await.unwrap();
        assert!(third_done.load(Ordering::SeqCst));
        assert_eq!(l.max_concurrent(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn interactive_overtakes_waiting_background() {
        let l = limiter(1.0, 1, 8);
        drop(l.acquire(Priority::Interactive).await); // ведро пусто
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..3 {
            let (l, order) = (l.clone(), order.clone());
            set.spawn(async move {
                drop(l.acquire(Priority::Background).await);
                order.lock().unwrap().push("bg");
            });
        }
        tokio::task::yield_now().await;
        let (l2, order2) = (l.clone(), order.clone());
        set.spawn(async move {
            drop(l2.acquire(Priority::Interactive).await);
            order2.lock().unwrap().push("ui");
        });
        while set.join_next().await.is_some() {}
        assert_eq!(order.lock().unwrap().first(), Some(&"ui"));
        assert_eq!(order.lock().unwrap().len(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn background_never_takes_the_last_token() {
        let l = limiter(1.0, 3, 8);
        // Фоновые берут токены, пока в ведре ≥ 2: проходит один (3 → 2 → ждёт до 2 снова).
        assert_eq!(elapsed_of(&l, Priority::Background).await, Duration::ZERO);
        assert_eq!(elapsed_of(&l, Priority::Background).await, Duration::ZERO);
        // В ведре остался один токен — фоновый ждёт пополнения, интерактивный берёт сразу.
        let bg = elapsed_of(&l, Priority::Background).await;
        assert!(bg >= Duration::from_millis(900), "{bg:?}");
        // После ожидания в ведре снова 1 токен (после взятия): интерактивный проходит сразу.
        assert_eq!(elapsed_of(&l, Priority::Interactive).await, Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn background_with_single_token_bucket_still_progresses() {
        let l = limiter(2.0, 1, 8);
        drop(l.acquire(Priority::Background).await);
        let e = elapsed_of(&l, Priority::Background).await;
        assert!(e >= Duration::from_millis(450), "{e:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn throttling_halves_rate_empties_bucket_and_recovers() {
        let l = limiter(1.0, 3, 8);
        l.on_throttled(None);
        assert_eq!(l.current_rate(), Some(0.5));
        let e = elapsed_of(&l, Priority::Interactive).await;
        assert!(
            e >= Duration::from_millis(1900),
            "ведро пустое, темп 0.5/с: {e:?}"
        );
        l.on_throttled(None);
        l.on_throttled(None);
        l.on_throttled(None);
        assert_eq!(l.current_rate(), Some(MIN_ADAPTIVE_RATE), "не ниже 0.2");
        for _ in 0..RECOVERY_EVERY - 1 {
            l.on_success();
        }
        assert_eq!(l.current_rate(), Some(MIN_ADAPTIVE_RATE));
        l.on_success();
        assert_eq!(l.current_rate(), Some(0.25));
        for _ in 0..RECOVERY_EVERY * 20 {
            l.on_success();
        }
        assert_eq!(l.current_rate(), Some(1.0), "не выше заданного");
    }

    #[tokio::test(start_paused = true)]
    async fn throttling_below_floor_ceiling_keeps_ceiling() {
        let l = limiter(0.1, 1, 1);
        l.on_throttled(None);
        assert_eq!(l.current_rate(), Some(0.1), "пол не выше заданного темпа");
    }

    #[tokio::test(start_paused = true)]
    async fn retry_after_pauses_everyone() {
        let l = limiter(0.0, 1, 8);
        l.on_throttled(Some(Duration::from_secs(7)));
        let e = elapsed_of(&l, Priority::Interactive).await;
        assert!(e >= Duration::from_secs(7), "{e:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn unlimited_rate_degrades_and_returns_to_unlimited() {
        let l = limiter(0.0, 1, 8);
        l.on_throttled(None);
        assert_eq!(l.current_rate(), Some(UNLIMITED_FALLBACK_RATE));
        for _ in 0..RECOVERY_EVERY * 30 {
            l.on_success();
        }
        assert_eq!(l.current_rate(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn waiting_background_does_not_poll() {
        let l = limiter(0.1, 1, 8);
        drop(l.acquire(Priority::Interactive).await); // ведро пусто
        let ui = {
            let l = l.clone();
            tokio::spawn(async move { drop(l.acquire(Priority::Interactive).await) })
        };
        tokio::task::yield_now().await;
        let bg = {
            let l = l.clone();
            tokio::spawn(async move { drop(l.acquire(Priority::Background).await) })
        };
        tokio::task::yield_now().await;
        let before = l.wakeups.load(Ordering::SeqCst);
        // Раньше фоновый просыпался каждые 10 мс (≈ 500 раз за 5 с).
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
        let woke = l.wakeups.load(Ordering::SeqCst) - before;
        assert!(woke <= 2, "пробуждений: {woke}");
        ui.await.unwrap();
        bg.await.unwrap();
    }
}
