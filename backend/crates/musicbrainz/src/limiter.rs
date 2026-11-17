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
/// Сколько тишины (без 503/429) нужно для удвоения сниженного темпа — независимо от числа запросов.
const RECOVERY_QUIET: Duration = Duration::from_secs(60);
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
    /// Начало текущего «тихого» периода: последний 503/429 или последнее восстановление по времени.
    /// `None` — темп не снижен.
    quiet_since: Option<Instant>,
    /// Следующий номер в очереди.
    next_ticket: u64,
    /// Очереди ожидающих токен: строго по порядку прихода внутри класса; фоновые идут, только когда
    /// интерактивных нет. Справедливая очередь вместо «кто первым проснулся»: ожидание
    /// предсказуемо (`место / темп`), никто не голодает.
    queue_interactive: std::collections::VecDeque<u64>,
    queue_background: std::collections::VecDeque<u64>,
}

impl State {
    fn queue(&mut self, priority: Priority) -> &mut std::collections::VecDeque<u64> {
        match priority {
            Priority::Interactive => &mut self.queue_interactive,
            Priority::Background => &mut self.queue_background,
        }
    }

    /// Восстановление по времени: за каждые `RECOVERY_QUIET` без отказов темп ×2 до потолка
    /// (без лимита — возврат к «без ограничения» после превышения `UNLIMITED_FALLBACK_RATE`).
    fn recover_by_time(&mut self, now: Instant) {
        while let Some(since) = self.quiet_since {
            if now.saturating_duration_since(since) < RECOVERY_QUIET || !self.rate.is_finite() {
                if !self.rate.is_finite() {
                    self.quiet_since = None;
                }
                return;
            }
            // Токены, накопленные до смены темпа, считаем по старому темпу.
            self.refill(since + RECOVERY_QUIET);
            let next = self.rate * 2.0;
            if self.ceiling > 0.0 {
                self.rate = next.min(self.ceiling);
                self.quiet_since = (self.rate < self.ceiling).then_some(since + RECOVERY_QUIET);
            } else if next > UNLIMITED_FALLBACK_RATE {
                self.rate = f64::INFINITY;
                self.quiet_since = None;
            } else {
                self.rate = next;
                self.quiet_since = Some(since + RECOVERY_QUIET);
            }
        }
    }

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
/// Очередь справедливая (FIFO внутри класса). Фоновый запрос не берёт токен, пока ждёт хотя бы один
/// интерактивный, и никогда не берёт последний токен ведра (он остаётся интерактивным).
/// Ожидание — на `Notify` и таймере, без опроса.
pub(crate) struct Limiter {
    state: Mutex<State>,
    wake: Notify,
    slots: Arc<Semaphore>,
    max_concurrent: usize,
    /// Сколько раз ожидающий просыпался (для теста «нет busy-loop»).
    wakeups: AtomicUsize,
}

/// Разрешение на один HTTP-запрос; слот параллелизма освобождается при `drop`.
pub(crate) struct Permit {
    _slot: OwnedSemaphorePermit,
}

/// Место в очереди: при `drop` (запрос отменён или токен взят) освобождает его и будит остальных.
struct TicketGuard<'a> {
    limiter: &'a Limiter,
    priority: Priority,
    ticket: u64,
}

impl Drop for TicketGuard<'_> {
    fn drop(&mut self) {
        self.limiter
            .state()
            .queue(self.priority)
            .retain(|t| *t != self.ticket);
        // Следующие в очереди могли ждать именно этого.
        self.limiter.wake.notify_waiters();
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
                quiet_since: None,
                next_ticket: 0,
                queue_interactive: std::collections::VecDeque::new(),
                queue_background: std::collections::VecDeque::new(),
            }),
            wake: Notify::new(),
            slots: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            wakeups: AtomicUsize::new(0),
        }
    }

    /// Сколько нового запроса в худшем случае придётся ждать из-за уже стоящих в очереди и
    /// летящих: `(ждут + в полёте) / темп`. Для «без ограничения темпа» — ноль.
    pub(crate) fn expected_wait(&self) -> Duration {
        let (rate, queued) = {
            let st = self.state();
            (
                st.rate,
                st.queue_interactive.len() + st.queue_background.len(),
            )
        };
        if !rate.is_finite() || rate <= 0.0 {
            return Duration::ZERO;
        }
        let in_flight = self
            .max_concurrent
            .saturating_sub(self.slots.available_permits());
        let ahead = queued + in_flight;
        Duration::from_secs_f64(ahead as f64 / rate)
    }

    pub(crate) fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ждёт токен и слот параллелизма.
    pub(crate) async fn acquire(&self, priority: Priority) -> Permit {
        let ticket = {
            let mut st = self.state();
            let t = st.next_ticket;
            st.next_ticket += 1;
            st.queue(priority).push_back(t);
            t
        };
        let _place = TicketGuard {
            limiter: self,
            priority,
            ticket,
        };
        loop {
            // Подписка до проверки состояния: событие между проверкой и ожиданием не теряется.
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let wait = match self.try_take(priority, ticket) {
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
    fn try_take(&self, priority: Priority, ticket: u64) -> Result<(), Option<Duration>> {
        let background = priority == Priority::Background;
        let mut st = self.state();
        // Брать токен может только первый в своей очереди, и фоновый — только если интерактивных нет.
        if st.queue(priority).front() != Some(&ticket)
            || (background && !st.queue_interactive.is_empty())
        {
            return Err(None);
        }
        let now = Instant::now();
        if let Some(until) = st.blocked_until {
            if until > now {
                return Err(Some(until - now));
            }
            st.blocked_until = None;
        }
        st.recover_by_time(now);
        st.refill(now);
        if !st.rate.is_finite() {
            st.queue(priority).pop_front();
            drop(st);
            self.wake.notify_waiters();
            return Ok(());
        }
        // Фоновый оставляет в ведре последний токен; при burst = 1 резерв невозможен.
        let need = if background { st.burst.min(2.0) } else { 1.0 };
        if st.tokens >= need {
            st.tokens -= 1.0;
            st.queue(priority).pop_front();
            drop(st);
            // Следующий в очереди проверит своё время.
            self.wake.notify_waiters();
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
            st.quiet_since = Some(now);
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
    async fn expected_wait_grows_with_the_queue_and_falls_with_the_rate() {
        let l = Arc::new(Limiter::new(MbLimits::paced(2.0)));
        assert_eq!(l.expected_wait(), Duration::ZERO);
        let first = l.acquire(Priority::Interactive).await; // токен взят, слот занят
        assert_eq!(l.expected_wait(), Duration::from_millis(500));
        let l2 = l.clone();
        let waiter = tokio::spawn(async move { l2.acquire(Priority::Background).await });
        tokio::task::yield_now().await;
        assert_eq!(
            l.expected_wait(),
            Duration::from_secs(1),
            "в полёте один и один ждёт"
        );
        drop(first);
        drop(waiter.await.unwrap());
        assert_eq!(l.expected_wait(), Duration::ZERO);
        let unlimited = Limiter::new(MbLimits::unlimited(4));
        assert_eq!(unlimited.expected_wait(), Duration::ZERO);
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
    async fn rate_recovers_by_time_without_requests() {
        let l = limiter(1.0, 3, 8);
        for _ in 0..5 {
            l.on_throttled(None);
        }
        assert_eq!(l.current_rate(), Some(MIN_ADAPTIVE_RATE));
        tokio::time::advance(RECOVERY_QUIET).await;
        drop(l.acquire(Priority::Interactive).await);
        assert_eq!(l.current_rate(), Some(0.4));
        tokio::time::advance(RECOVERY_QUIET).await;
        drop(l.acquire(Priority::Interactive).await);
        assert_eq!(l.current_rate(), Some(0.8));
        tokio::time::advance(RECOVERY_QUIET).await;
        drop(l.acquire(Priority::Interactive).await);
        assert_eq!(l.current_rate(), Some(1.0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_throttle_restarts_the_quiet_period() {
        let l = limiter(1.0, 3, 8);
        l.on_throttled(None);
        l.on_throttled(None);
        l.on_throttled(None);
        l.on_throttled(None);
        tokio::time::advance(Duration::from_secs(50)).await;
        l.on_throttled(None);
        tokio::time::advance(Duration::from_secs(10)).await; // 60 с после первого, 10 после последнего
        drop(l.acquire(Priority::Interactive).await);
        assert_eq!(l.current_rate(), Some(MIN_ADAPTIVE_RATE));
        tokio::time::advance(Duration::from_secs(50)).await;
        drop(l.acquire(Priority::Interactive).await);
        assert_eq!(l.current_rate(), Some(0.4));
    }

    #[tokio::test(start_paused = true)]
    async fn unlimited_rate_returns_to_unlimited_by_time() {
        let l = limiter(0.0, 1, 8);
        for _ in 0..6 {
            l.on_throttled(None);
        }
        assert_eq!(l.current_rate(), Some(MIN_ADAPTIVE_RATE));
        // 0,2 → 0,4 → … → 3,2 → «без ограничения»: пять минут тишины.
        tokio::time::advance(RECOVERY_QUIET * 5).await;
        drop(l.acquire(Priority::Interactive).await);
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

    /// Справедливость: пять фоновых ожидающих получают токены строго в порядке прихода, и каждый
    /// ждёт не дольше `место / темп` (раньше «кто первым проснулся» обделял часть ожидающих).
    #[tokio::test(start_paused = true)]
    async fn background_waiters_are_served_in_arrival_order() {
        let l = Arc::new(Limiter::new(MbLimits::paced(2.0)));
        let first = l.acquire(Priority::Interactive).await; // токен ведра занят
        let order = Arc::new(Mutex::new(Vec::new()));
        let t0 = Instant::now();
        let mut tasks = vec![];
        for i in 0..5 {
            let (l, order) = (l.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                let _p = l.acquire(Priority::Background).await;
                order.lock().unwrap().push((i, t0.elapsed()));
            }));
            tokio::task::yield_now().await; // порядок прихода — по номеру
        }
        drop(first);
        for t in tasks {
            t.await.unwrap();
        }
        let got = order.lock().unwrap().clone();
        assert_eq!(
            got.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        // Темп 2/с: пятый получает токен примерно через 5 × 0,5 с, а не «когда повезёт».
        assert!(got[4].1 <= Duration::from_secs(4), "{:?}", got[4].1);
    }

    /// Отменённый ожидающий освобождает своё место: очередь не «зависает» на мёртвом билете.
    #[tokio::test(start_paused = true)]
    async fn cancelled_head_of_the_queue_does_not_block_the_rest() {
        let l = Arc::new(Limiter::new(MbLimits::paced(2.0)));
        let first = l.acquire(Priority::Interactive).await;
        let l2 = l.clone();
        let doomed = tokio::spawn(async move { l2.acquire(Priority::Background).await });
        tokio::task::yield_now().await;
        let l3 = l.clone();
        let next = tokio::spawn(async move { l3.acquire(Priority::Background).await });
        tokio::task::yield_now().await;
        doomed.abort();
        drop(first);
        let got = tokio::time::timeout(Duration::from_secs(5), next).await;
        assert!(got.is_ok(), "очередь застряла за отменённым запросом");
    }
}
