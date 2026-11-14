//! Вычисление info-hash из содержимого `.torrent` (SHA-1 от bencode-значения `info`).

use nimbus_core::model::InfoHash;
use sha1::{Digest, Sha1};

/// Возвращает конец bencode-значения, начинающегося в `pos`.
fn skip_value(b: &[u8], pos: usize, depth: u32) -> Option<usize> {
    if depth > 64 {
        return None;
    }
    match *b.get(pos)? {
        b'i' => {
            let end = b[pos..].iter().position(|c| *c == b'e')?;
            Some(pos + end + 1)
        }
        b'l' => {
            let mut p = pos + 1;
            while *b.get(p)? != b'e' {
                p = skip_value(b, p, depth + 1)?;
            }
            Some(p + 1)
        }
        b'd' => {
            let mut p = pos + 1;
            while *b.get(p)? != b'e' {
                p = skip_value(b, p, depth + 1)?; // ключ
                p = skip_value(b, p, depth + 1)?; // значение
            }
            Some(p + 1)
        }
        b'0'..=b'9' => {
            let (len, colon) = read_len(b, pos)?;
            let end = colon + 1 + len;
            (end <= b.len()).then_some(end)
        }
        _ => None,
    }
}

/// Читает «<len>:» и возвращает (len, позиция двоеточия).
fn read_len(b: &[u8], pos: usize) -> Option<(usize, usize)> {
    let colon = pos + b[pos..].iter().position(|c| *c == b':')?;
    let len = std::str::from_utf8(&b[pos..colon]).ok()?.parse().ok()?;
    Some((len, colon))
}

pub fn info_hash_of_torrent(data: &[u8]) -> Option<InfoHash> {
    if *data.first()? != b'd' {
        return None;
    }
    let mut p = 1;
    while *data.get(p)? != b'e' {
        let (klen, colon) = read_len(data, p)?;
        let key = data.get(colon + 1..colon + 1 + klen)?;
        let vstart = colon + 1 + klen;
        let vend = skip_value(data, vstart, 0)?;
        if key == b"info" {
            let digest = Sha1::digest(&data[vstart..vend]);
            let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            return InfoHash::parse(&hex).ok();
        }
        p = vend;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_info_dict() {
        let info = b"d6:lengthi3e4:name1:a12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
        let mut t = b"d8:announce3:url4:info".to_vec();
        t.extend_from_slice(info);
        t.extend_from_slice(b"e");
        let expected: String = Sha1::digest(info)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(info_hash_of_torrent(&t).unwrap().as_str(), expected);
    }

    #[test]
    fn rejects_garbage() {
        assert!(info_hash_of_torrent(b"<html>").is_none());
        assert!(info_hash_of_torrent(b"d4:spam3:egge").is_none());
        assert!(info_hash_of_torrent(b"d4:info").is_none());
    }
}

#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// Сгенерированный торрент → info-hash равен SHA-1 от байтов словаря `info`.
        #[test]
        fn hash_matches_info_bytes(name in "[a-z]{1,12}", len in 0u32..1_000_000, announce in "[a-z]{0,20}") {
            let info = format!("d6:lengthi{len}e4:name{}:{name}12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe", name.len());
            let t = format!("d8:announce{}:{announce}4:info{info}e", announce.len());
            let expected: String = Sha1::digest(info.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            let got = info_hash_of_torrent(t.as_bytes()).expect("valid torrent");
            prop_assert_eq!(got.to_string(), expected);
        }

        #[test]
        fn random_bytes_never_panic(data in proptest::collection::vec(any::<u8>(), 0..200)) {
            let _ = info_hash_of_torrent(&data);
        }

        /// Случайные «похожие на bencode» данные тоже не паникуют.
        #[test]
        fn bencode_like_never_panics(s in "[dil0-9:eAx]{0,60}") {
            let _ = info_hash_of_torrent(s.as_bytes());
        }
    }
}
