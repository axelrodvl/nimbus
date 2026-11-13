//! Общие помощники для тестов бэкенда (только `dev-dependencies`).
//!
//! Сюда кладём то, что иначе копируется по тестам: ожидание условия, временные каталоги, общие фейки.

use std::future::Future;
use std::time::Duration;

/// Период опроса условия в [`eventually`].
const POLL: Duration = Duration::from_millis(20);

/// Ждёт, пока `f` не вернёт `true`; опрашивает каждые 20 мс.
/// Паникует с сообщением, если условие не выполнилось за `timeout`.
/// Заменяет самодельные циклы `loop { sleep }` в тестах.
pub async fn eventually<F, Fut>(timeout: Duration, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if f().await {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("condition not met within {timeout:?}");
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Временный каталог, удаляемый при drop.
pub fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("создание временного каталога")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn eventually_returns_when_condition_becomes_true() {
        let n = AtomicU32::new(0);
        eventually(Duration::from_secs(5), || async {
            n.fetch_add(1, Ordering::SeqCst) >= 3
        })
        .await;
        assert!(n.load(Ordering::SeqCst) >= 4);
    }

    #[tokio::test]
    #[should_panic(expected = "condition not met")]
    async fn eventually_panics_on_timeout() {
        eventually(Duration::from_millis(100), || async { false }).await;
    }

    #[test]
    fn tempdir_exists_and_is_removed_on_drop() {
        let d = tempdir();
        let p = d.path().to_path_buf();
        assert!(p.is_dir());
        drop(d);
        assert!(!p.exists());
    }
}
