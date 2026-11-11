use nimbus_core::model::InfoHash;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

pub const PUBLIC_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
];

/// Кодируем всё, кроме unreserved-символов RFC 3986.
const ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn build_magnet(info_hash: &InfoHash, name: &str, trackers: &[&str]) -> String {
    let mut m = format!(
        "magnet:?xt=urn:btih:{}&dn={}",
        info_hash,
        utf8_percent_encode(name, ENCODE)
    );
    for tr in trackers {
        m.push_str("&tr=");
        m.push_str(&utf8_percent_encode(tr, ENCODE).to_string());
    }
    m
}
