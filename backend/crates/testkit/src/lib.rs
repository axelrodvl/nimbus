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

/// Минимальный валидный многофайловый `.torrent` (bencode) без реальных данных: имя раздачи `name`
/// и файлы `(путь через «/», размер)`. Хеши кусков нулевые — годится для разбора списка файлов
/// и вычисления info-hash, но не для скачивания.
pub fn torrent_file(name: &str, files: &[(&str, u64)]) -> Vec<u8> {
    const PIECE_LEN: u64 = 16 * 1024;
    fn bstr(out: &mut Vec<u8>, s: &[u8]) {
        out.extend_from_slice(format!("{}:", s.len()).as_bytes());
        out.extend_from_slice(s);
    }
    let total: u64 = files.iter().map(|(_, n)| n).sum();
    let pieces = total.div_ceil(PIECE_LEN).max(1) as usize;
    let mut out = b"d4:infod5:filesl".to_vec();
    for (path, size) in files {
        out.extend_from_slice(format!("d6:lengthi{size}e4:pathl").as_bytes());
        for part in path.split('/') {
            bstr(&mut out, part.as_bytes());
        }
        out.extend_from_slice(b"ee");
    }
    out.extend_from_slice(b"e4:name");
    bstr(&mut out, name.as_bytes());
    out.extend_from_slice(format!("12:piece lengthi{PIECE_LEN}e6:pieces").as_bytes());
    bstr(&mut out, &vec![0u8; pieces * 20]);
    out.extend_from_slice(b"ee");
    out
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
    fn torrent_file_is_wellformed_bencode() {
        let b = torrent_file("Album", &[("a/01.flac", 100), ("02.flac", 20_000)]);
        assert!(b.starts_with(b"d4:infod5:filesl"));
        assert!(b.ends_with(b"ee"));
        // 20 100 байт → 2 куска по 16 КБ → 40 байт хешей.
        assert!(b.windows(8).any(|w| w == b"6:pieces"));
        assert!(b.windows(3).any(|w| w == b"40:"));
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
