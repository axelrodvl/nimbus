//! Адаптер «таймаут простоя» для тела стрима: если следующий кусок не пришёл вовремя,
//! поток завершается ошибкой (соединение рвётся), а клиент переподключается с `Range`.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::Stream;
use tokio::time::{Instant, Sleep};

/// Вызывается один раз, когда сработал таймаут простоя.
pub type OnIdle = Box<dyn FnOnce() + Send>;

/// Оборачивает поток кусков. Таймер запускается, только когда внутренний поток ответил `Pending`
/// (медленный клиент, который не вызывает `poll_next`, таймаут не вызывает), и сбрасывается
/// при каждом реально выданном куске.
pub struct IdleTimeout<S> {
    inner: S,
    timeout: Duration,
    sleep: Pin<Box<Sleep>>,
    waiting: bool,
    done: bool,
    on_idle: Option<OnIdle>,
}

impl<S> IdleTimeout<S> {
    pub fn new(inner: S, timeout: Duration, on_idle: Option<OnIdle>) -> Self {
        Self {
            inner,
            timeout,
            sleep: Box::pin(tokio::time::sleep(timeout)),
            waiting: false,
            done: false,
            on_idle,
        }
    }
}

impl<S, T> Stream for IdleTimeout<S>
where
    S: Stream<Item = io::Result<T>> + Unpin,
{
    type Item = io::Result<T>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        if this.done {
            return Poll::Ready(None);
        }
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(item) => {
                this.waiting = false;
                if item.is_none() {
                    this.done = true;
                }
                Poll::Ready(item)
            }
            Poll::Pending => {
                if !this.waiting {
                    this.waiting = true;
                    this.sleep.as_mut().reset(Instant::now() + this.timeout);
                }
                if this.sleep.as_mut().poll(cx).is_ready() {
                    this.done = true;
                    if let Some(f) = this.on_idle.take() {
                        f();
                    }
                    return Poll::Ready(Some(Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "stream idle timeout",
                    ))));
                }
                Poll::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::channel::mpsc;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    type Tx = mpsc::UnboundedSender<io::Result<u8>>;
    type Rx = mpsc::UnboundedReceiver<io::Result<u8>>;

    fn chan() -> (Tx, Rx) {
        mpsc::unbounded()
    }

    #[tokio::test(start_paused = true)]
    async fn fires_after_silence_and_calls_back_once() {
        let (_tx, rx) = chan();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        let mut s = IdleTimeout::new(
            rx,
            Duration::from_secs(5),
            Some(Box::new(move || {
                f.fetch_add(1, Ordering::SeqCst);
            })),
        );
        let e = s.next().await.unwrap().unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        assert!(s.next().await.is_none(), "после ошибки поток закрыт");
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn every_chunk_resets_the_timer() {
        let (tx, rx) = chan();
        let mut s = IdleTimeout::new(rx, Duration::from_secs(5), None);
        for i in 0..4u8 {
            tokio::time::sleep(Duration::from_secs(4)).await; // всего 16 с > 5 с
            tx.unbounded_send(Ok(i)).unwrap();
            assert_eq!(s.next().await.unwrap().unwrap(), i);
        }
        tx.close_channel();
        assert!(s.next().await.is_none(), "конец потока — без ошибки");
    }

    #[tokio::test(start_paused = true)]
    async fn slow_consumer_is_not_a_timeout() {
        let (tx, rx) = chan();
        let mut s = IdleTimeout::new(rx, Duration::from_secs(5), None);
        tx.unbounded_send(Ok(1)).unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await; // клиент долго не читает
        assert_eq!(s.next().await.unwrap().unwrap(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn inner_errors_pass_through() {
        let (tx, rx) = chan();
        let mut s = IdleTimeout::new(rx, Duration::from_secs(5), None);
        tx.unbounded_send(Err(io::Error::other("boom"))).unwrap();
        assert_eq!(s.next().await.unwrap().unwrap_err().to_string(), "boom");
    }
}
