//! Классификация и ранжирование кандидатов-раздач (чистые функции).

use std::sync::OnceLock;

use nimbus_core::model::TorrentKind;
use regex::Regex;

use crate::types::TorrentCandidate;

/// Веса и пороги — в одном месте.
pub mod weights {
    pub const ARTIST_MIN_SIMILARITY: f32 = 0.85;
    /// Минимальное совпадение названия альбома для раздач, не являющихся дискографией.
    pub const ALBUM_MIN_SIMILARITY: f32 = 0.5;
    pub const ALBUM_SIMILARITY: f32 = 0.35;
    pub const KIND_ALBUM: f32 = 0.15;
    pub const KIND_DISCOGRAPHY: f32 = 0.05;
    pub const KIND_SINGLE: f32 = -0.10;
    pub const SEEDERS: f32 = 0.25;
    /// Сиды неизвестны (например, RuTracker до resolve).
    pub const SEEDERS_UNKNOWN: f32 = 0.05;
    /// 0 сидов по данным трекера: раздача не отбрасывается (счётчик часто устарел,
    /// пиры могут быть доступны через DHT), но получает штраф.
    pub const SEEDERS_ZERO_PENALTY: f32 = -0.10;
    /// Сколько сидов считается «достаточно» (насыщение логарифма).
    pub const SEEDERS_SATURATION: f32 = 50.0;
    pub const FORMAT: f32 = 0.15;
    pub const YEAR: f32 = 0.05;
    pub const JUNK: f32 = -0.30;
    pub const SIZE_PENALTY: f32 = -0.20;
    pub const ALBUM_MIN_BYTES: u64 = 20 * 1024 * 1024;
    pub const DISCOGRAPHY_MAX_BYTES: u64 = 200 * 1024 * 1024 * 1024;
}

#[derive(Debug, Clone, Copy)]
pub struct RankInput<'a> {
    pub artist: &'a str,
    /// Пусто — ищем дискографию артиста целиком.
    pub album: &'a str,
    pub year: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Flac,
    Alac,
    Mp3_320,
    Mp3V0,
    Aac,
    ApeWv,
    Mp3Other,
}

#[derive(Debug, Clone)]
pub struct FormatPrefs {
    /// От самого предпочтительного к наименее.
    pub order: Vec<AudioFormat>,
}

impl Default for FormatPrefs {
    fn default() -> Self {
        use AudioFormat::*;
        Self {
            order: vec![Flac, Alac, Mp3_320, Mp3V0, Aac, ApeWv, Mp3Other],
        }
    }
}

impl AudioFormat {
    pub fn from_key(key: &str) -> Option<Self> {
        use AudioFormat::*;
        Some(match key {
            "flac" => Flac,
            "alac" => Alac,
            "mp3_320" => Mp3_320,
            "mp3_v0" => Mp3V0,
            "aac" => Aac,
            "ape_wv" => ApeWv,
            "mp3_other" => Mp3Other,
            _ => return None,
        })
    }
}

impl FormatPrefs {
    /// Порядок из настроек (`search.format_prefs`); неизвестные ключи пропускаются.
    pub fn from_keys(keys: &[String]) -> Self {
        let order: Vec<AudioFormat> = keys
            .iter()
            .filter_map(|k| AudioFormat::from_key(k))
            .collect();
        if order.is_empty() {
            Self::default()
        } else {
            Self { order }
        }
    }

    fn bonus(&self, f: AudioFormat) -> f32 {
        match self.order.iter().position(|x| *x == f) {
            Some(i) => weights::FORMAT * (1.0 - i as f32 / self.order.len() as f32),
            None => 0.0,
        }
    }
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("valid regex"))
}

/// Нижний регистр, транслитерация, без пунктуации, схлопнутые пробелы.
pub fn normalize(s: &str) -> String {
    deunicode::deunicode(s)
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_brackets(s: &str) -> String {
    crate::query::strip_brackets(s)
}

/// Доля токенов `needle`, найденных среди токенов `haystack` (0..1).
fn containment(needle: &str, haystack: &str) -> f32 {
    let n = normalize(needle);
    let tokens: Vec<&str> = n.split(' ').filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return 0.0;
    }
    let h = normalize(haystack);
    let hay: std::collections::HashSet<&str> = h.split(' ').collect();
    tokens.iter().filter(|t| hay.contains(*t)).count() as f32 / tokens.len() as f32
}

pub fn classify(title: &str, _artist: &str, album: &str) -> TorrentKind {
    static DISCO: OnceLock<Regex> = OnceLock::new();
    static SINGLE: OnceLock<Regex> = OnceLock::new();
    let lower = title.to_lowercase();
    if re(
        &DISCO,
        r"discograph|дискограф|collection|complete|anthology|\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b",
    )
    .is_match(&lower)
    {
        return TorrentKind::Discography;
    }
    if re(&SINGLE, r"\bsingles?\b|\bсингл|\bsingle\b").is_match(&lower) {
        return TorrentKind::Single;
    }
    let album = strip_brackets(album);
    if !album.is_empty() && containment(&album, title) >= weights::ALBUM_MIN_SIMILARITY {
        return TorrentKind::Album;
    }
    TorrentKind::Unknown
}

pub fn detect_format(title: &str) -> Option<AudioFormat> {
    static R: [OnceLock<Regex>; 7] = [
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
    ];
    let t = title.to_lowercase();
    let is = |i: usize, p: &str| re(&R[i], p).is_match(&t);
    if is(0, r"flac|24[ -]?bit|hi-?res") {
        Some(AudioFormat::Flac)
    } else if is(1, r"alac") {
        Some(AudioFormat::Alac)
    } else if is(2, r"\b320\b|320\s?k") {
        Some(AudioFormat::Mp3_320)
    } else if is(3, r"\bv0\b") {
        Some(AudioFormat::Mp3V0)
    } else if is(4, r"\baac\b") {
        Some(AudioFormat::Aac)
    } else if is(5, r"\bape\b|\bwv\b|wavpack") {
        Some(AudioFormat::ApeWv)
    } else if t.contains("mp3") {
        Some(AudioFormat::Mp3Other)
    } else {
        None
    }
}

fn junk_penalty(title: &str, album: &str) -> f32 {
    static JUNK: OnceLock<Regex> = OnceLock::new();
    let lower = title.to_lowercase();
    let album_l = album.to_lowercase();
    let r = re(
        &JUNK,
        r"karaoke|караоке|\btributes?\b|\bcovers?\b|\bminus\b|минусовк|\bremix(es)?\b|\blive\b|bootleg",
    );
    // Ключевое слово, присутствующее в названии самого альбома, мусором не считается.
    let junk = r
        .find_iter(&lower)
        .any(|m| !album_l.contains(m.as_str().trim()));
    if junk {
        weights::JUNK
    } else {
        0.0
    }
}

/// Оценка кандидата. `< 0` — отбросить.
pub fn score(c: &TorrentCandidate, input: &RankInput, prefs: &FormatPrefs) -> f32 {
    use weights::*;
    // Артист обязателен.
    if containment(input.artist, &c.title) < ARTIST_MIN_SIMILARITY {
        return -1.0;
    }
    let album = strip_brackets(input.album);
    let kind = classify(&c.title, input.artist, &album);
    let mut s = 0.0;

    if !album.is_empty() {
        let sim = containment(&album, &c.title);
        // Для дискографии альбом в названии не нужен.
        if kind != TorrentKind::Discography {
            if sim < ALBUM_MIN_SIMILARITY {
                return -1.0;
            }
            s += ALBUM_SIMILARITY * sim;
        }
    }
    s += match kind {
        TorrentKind::Album => KIND_ALBUM,
        TorrentKind::Discography => KIND_DISCOGRAPHY,
        TorrentKind::Single if !album.is_empty() => KIND_SINGLE,
        _ => 0.0,
    };
    s += match c.seeders {
        Some(0) => SEEDERS_ZERO_PENALTY,
        Some(n) => SEEDERS * ((1.0 + n as f32).ln() / (1.0 + SEEDERS_SATURATION).ln()).min(1.0),
        None => SEEDERS_UNKNOWN,
    };
    if let Some(f) = detect_format(&c.title) {
        s += prefs.bonus(f);
    }
    if let Some(y) = input.year {
        let y = y.to_string();
        if c.title
            .split(|ch: char| !ch.is_ascii_digit())
            .any(|w| w == y)
        {
            s += YEAR;
        }
    }
    s += junk_penalty(&c.title, &album);
    if let Some(size) = c.size_bytes {
        let too_small = kind == TorrentKind::Album && size < ALBUM_MIN_BYTES;
        let too_big = kind == TorrentKind::Discography && size > DISCOGRAPHY_MAX_BYTES;
        if too_small || too_big {
            s += SIZE_PENALTY;
        }
    }
    s.min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nimbus_core::model::TorrentSource;

    fn cand(title: &str, seeders: Option<u32>, size: Option<u64>) -> TorrentCandidate {
        TorrentCandidate {
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: title.into(),
            info_hash: None,
            magnet: None,
            download_url: None,
            size_bytes: size,
            seeders,
            leechers: None,
            category: None,
            files_count: None,
            torrent_file: None,
        }
    }

    const MB: u64 = 1024 * 1024;

    #[test]
    fn classify_table() {
        use TorrentKind::*;
        let rows: &[(&str, &str, &str, TorrentKind)] = &[
            (
                "Radiohead - OK Computer (1997) [FLAC]",
                "Radiohead",
                "OK Computer",
                Album,
            ),
            (
                "Radiohead - Discography 1993-2016 (MP3 320)",
                "Radiohead",
                "OK Computer",
                Discography,
            ),
            (
                "Radiohead - OK Computer OKNOTOK 1997 2017 [FLAC 24bit]",
                "Radiohead",
                "OK Computer",
                Album,
            ),
            (
                "Кино - Группа крови (1988) [FLAC]",
                "Кино",
                "Группа крови",
                Album,
            ),
            (
                "Кино - Дискография (1982-1990) FLAC",
                "Кино",
                "Группа крови",
                Discography,
            ),
            (
                "Radiohead - The Complete Collection",
                "Radiohead",
                "Kid A",
                Discography,
            ),
            (
                "Radiohead - Creep (Single) [MP3]",
                "Radiohead",
                "Creep",
                Single,
            ),
            (
                "Radiohead - Kid A (2000) [FLAC]",
                "Radiohead",
                "OK Computer",
                Unknown,
            ),
            (
                "Queen - Greatest Hits Anthology",
                "Queen",
                "Greatest Hits",
                Discography,
            ),
            (
                "Radiohead - OK Computer (Deluxe Edition)",
                "Radiohead",
                "OK Computer [Remastered]",
                Album,
            ),
        ];
        for (title, artist, album, want) in rows {
            assert_eq!(classify(title, artist, album), *want, "{title}");
        }
    }

    #[test]
    fn format_detection() {
        use AudioFormat::*;
        let rows = [
            ("X [FLAC]", Some(Flac)),
            ("X [FLAC 24bit]", Some(Flac)),
            ("X (Hi-Res)", Some(Flac)),
            ("X [ALAC]", Some(Alac)),
            ("X (MP3 320)", Some(Mp3_320)),
            ("X MP3 V0", Some(Mp3V0)),
            ("X [AAC]", Some(Aac)),
            ("X [APE]", Some(ApeWv)),
            ("X WavPack", Some(ApeWv)),
            ("X [MP3 128]", Some(Mp3Other)),
            ("X (1997)", None),
        ];
        for (t, want) in rows {
            assert_eq!(detect_format(t), want, "{t}");
        }
    }

    fn sc(
        title: &str,
        seeders: Option<u32>,
        size: Option<u64>,
        album: &str,
        year: Option<i32>,
    ) -> f32 {
        score(
            &cand(title, seeders, size),
            &RankInput {
                artist: "Radiohead",
                album,
                year,
            },
            &FormatPrefs::default(),
        )
    }

    #[test]
    fn artist_is_mandatory() {
        assert!(
            sc(
                "Muse - OK Computer [FLAC]",
                Some(50),
                None,
                "OK Computer",
                None
            ) < 0.0
        );
        assert!(
            sc(
                "Radiohead - OK Computer [FLAC]",
                Some(50),
                None,
                "OK Computer",
                None
            ) > 0.0
        );
    }

    #[test]
    fn zero_seeders_are_penalized_not_discarded() {
        let zero = sc(
            "Radiohead - OK Computer",
            Some(0),
            None,
            "OK Computer",
            None,
        );
        let one = sc(
            "Radiohead - OK Computer",
            Some(1),
            None,
            "OK Computer",
            None,
        );
        assert!(zero > 0.0);
        assert!(zero < one);
        assert!(sc("Radiohead - OK Computer", None, None, "OK Computer", None) > zero);
    }

    #[test]
    fn other_album_is_discarded_but_discography_is_kept() {
        assert!(
            sc(
                "Radiohead - Kid A (2000) [FLAC]",
                Some(30),
                None,
                "OK Computer",
                None
            ) < 0.0
        );
        assert!(
            sc(
                "Radiohead - Discography 1993-2016 [FLAC]",
                Some(30),
                None,
                "OK Computer",
                None
            ) > 0.0
        );
    }

    #[test]
    fn ranking_order() {
        let a = |t: &str, s, size| sc(t, Some(s), size, "OK Computer", Some(1997));
        let flac = a("Radiohead - OK Computer (1997) [FLAC]", 40, Some(300 * MB));
        let mp3 = a(
            "Radiohead - OK Computer (1997) [MP3 320]",
            40,
            Some(100 * MB),
        );
        let low_mp3 = a(
            "Radiohead - OK Computer (1997) [MP3 128]",
            40,
            Some(50 * MB),
        );
        let few = a("Radiohead - OK Computer (1997) [FLAC]", 2, Some(300 * MB));
        let disco = a(
            "Radiohead - Discography 1993-2016 [FLAC]",
            40,
            Some(10 * 1024 * MB),
        );
        let single = a(
            "Radiohead - OK Computer (Single) [FLAC]",
            40,
            Some(300 * MB),
        );
        assert!(flac > mp3 && mp3 > low_mp3, "{flac} {mp3} {low_mp3}");
        assert!(flac > few);
        assert!(flac > disco, "{flac} {disco}");
        assert!(flac > single);
        assert!(flac <= 1.0);
    }

    #[test]
    fn year_bonus() {
        let with = sc(
            "Radiohead - OK Computer (1997) [FLAC]",
            Some(10),
            None,
            "OK Computer",
            Some(1997),
        );
        let without = sc(
            "Radiohead - OK Computer (1997) [FLAC]",
            Some(10),
            None,
            "OK Computer",
            Some(2001),
        );
        assert!((with - without - weights::YEAR).abs() < 1e-5);
    }

    #[test]
    fn junk_is_penalised() {
        let clean = sc(
            "Radiohead - OK Computer [FLAC]",
            Some(10),
            None,
            "OK Computer",
            None,
        );
        for t in [
            "Radiohead - OK Computer (Karaoke Version) [FLAC]",
            "A Tribute to Radiohead - OK Computer [FLAC]",
            "Radiohead - OK Computer Remix [FLAC]",
            "Radiohead - OK Computer Live [FLAC]",
            "Radiohead - OK Computer Bootleg [FLAC]",
            "Radiohead - OK Computer минусовка [FLAC]",
        ] {
            let s = sc(t, Some(10), None, "OK Computer", None);
            assert!(s < clean - 0.2, "{t}: {s} vs {clean}");
        }
        // Если «live» есть в названии альбома — это не мусор.
        let live = score(
            &cand(
                "Radiohead - I Might Be Wrong: Live Recordings [FLAC]",
                Some(10),
                None,
            ),
            &RankInput {
                artist: "Radiohead",
                album: "I Might Be Wrong: Live Recordings",
                year: None,
            },
            &FormatPrefs::default(),
        );
        assert!(live > 0.5, "{live}");
    }

    #[test]
    fn karaoke_without_album_match_is_discarded() {
        assert!(
            sc(
                "Karaoke - Radiohead hits",
                Some(10),
                None,
                "OK Computer",
                None
            ) < 0.0
        );
    }

    #[test]
    fn size_penalties() {
        let ok = sc(
            "Radiohead - OK Computer [FLAC]",
            Some(10),
            Some(300 * MB),
            "OK Computer",
            None,
        );
        let tiny = sc(
            "Radiohead - OK Computer [FLAC]",
            Some(10),
            Some(5 * MB),
            "OK Computer",
            None,
        );
        assert!((ok - tiny - 0.2).abs() < 1e-5);
        let big = sc(
            "Radiohead - Discography [FLAC]",
            Some(10),
            Some(300 * 1024 * MB),
            "",
            None,
        );
        let fine = sc(
            "Radiohead - Discography [FLAC]",
            Some(10),
            Some(10 * 1024 * MB),
            "",
            None,
        );
        assert!((fine - big - 0.2).abs() < 1e-5);
    }

    #[test]
    fn cyrillic_and_discography_search_without_album() {
        let input = RankInput {
            artist: "Кино",
            album: "",
            year: None,
        };
        let p = FormatPrefs::default();
        assert!(
            score(
                &cand("Кино - Дискография (1982-1990) [FLAC]", Some(25), None),
                &input,
                &p
            ) > 0.2
        );
        assert!(score(&cand("Цой - Дискография", Some(25), None), &input, &p) < 0.0);
        let album = RankInput {
            artist: "Кино",
            album: "Группа крови",
            year: Some(1988),
        };
        assert!(
            score(
                &cand("Кино - Группа крови (1988) [FLAC]", Some(25), None),
                &album,
                &p
            ) > 0.6
        );
    }

    #[test]
    fn normalize_works() {
        assert_eq!(
            normalize("  AC/DC — Back  in Black!! "),
            "ac dc back in black"
        );
        assert_eq!(normalize("Кино"), "kino");
    }
}
