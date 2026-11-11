//! Разбор имён аудиофайлов и каталогов.

use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedName {
    pub disc: Option<u32>,
    pub track: Option<u32>,
    pub artist: Option<String>,
    /// Название без номера (и без исполнителя, если он распознан).
    pub title: String,
    /// Всё после номера трека (`Artist - Title` целиком) — запасной вариант сравнения.
    pub rest: String,
}

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "m4a", "aac", "ogg", "opus", "ape", "wv", "wav", "aiff", "alac", "dsf", "dff",
];

pub fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    Some(ext.to_ascii_lowercase())
}

pub fn is_audio(path: &str) -> bool {
    extension(path).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Имя файла без расширения.
pub fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => name,
    }
}

/// Каталог файла (без имени); корень — пустая строка.
pub fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn num(s: &str) -> Option<u32> {
    s.parse().ok()
}

pub fn parse_filename(stem: &str) -> ParsedName {
    static DISC_TRACK: OnceLock<Regex> = OnceLock::new();
    static TRACK_FIRST: OnceLock<Regex> = OnceLock::new();
    static ARTIST_TRACK: OnceLock<Regex> = OnceLock::new();
    static ONLY_NUM: OnceLock<Regex> = OnceLock::new();
    static TRACK_WORD: OnceLock<Regex> = OnceLock::new();
    let r = |c: &'static OnceLock<Regex>, p: &str| -> &'static Regex {
        c.get_or_init(|| Regex::new(p).expect("valid regex"))
    };
    let s = stem.trim();

    // «01», «Track01», «track 1» — названия нет.
    if let Some(c) = r(&ONLY_NUM, r"^(\d{1,3})$").captures(s) {
        return ParsedName {
            track: num(&c[1]),
            ..ParsedName::default()
        };
    }
    if let Some(c) = r(&TRACK_WORD, r"(?i)^(?:track|трек)[\s._-]*(\d{1,3})$").captures(s) {
        return ParsedName {
            track: num(&c[1]),
            ..ParsedName::default()
        };
    }
    // «1-01 Title»
    if let Some(c) = r(&DISC_TRACK, r"^(\d)[-.](\d{1,2})[\s._-]+(.+)$").captures(s) {
        return ParsedName {
            disc: num(&c[1]),
            track: num(&c[2]),
            artist: None,
            title: c[3].trim().to_string(),
            rest: c[3].trim().to_string(),
        };
    }
    // «01 - Title», «01. Title», «01 Artist - Title»
    if let Some(c) = r(&TRACK_FIRST, r"^(\d{1,3})[\s._-]+(?:(.+?)\s+-\s+)?(.+)$").captures(s) {
        let artist = c.get(2).map(|m| m.as_str().trim().to_string());
        let title = c[3].trim().to_string();
        let rest = match &artist {
            Some(a) => format!("{a} - {title}"),
            None => title.clone(),
        };
        return ParsedName {
            disc: None,
            track: num(&c[1]),
            artist,
            title,
            rest,
        };
    }
    // «Artist - 01 - Title»
    if let Some(c) = r(&ARTIST_TRACK, r"^(.+?)\s+-\s+(\d{1,3})\s+-\s+(.+)$").captures(s) {
        return ParsedName {
            disc: None,
            track: num(&c[2]),
            artist: Some(c[1].trim().to_string()),
            title: c[3].trim().to_string(),
            rest: c[3].trim().to_string(),
        };
    }
    ParsedName {
        title: s.to_string(),
        rest: s.to_string(),
        ..ParsedName::default()
    }
}

/// Номер диска из имени каталога вида `CD1`, `CD 2`, `Disc 1`, `Disk2`, `Диск 3`.
pub fn disc_dir_number(component: &str) -> Option<u32> {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)^(?:cd|disc|disk|диск)[\s._-]*(\d{1,2})(?:\D.*)?$").expect("valid regex")
    })
    .captures(component.trim())
    .and_then(|c| num(&c[1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> (Option<u32>, Option<u32>, Option<String>, String) {
        let r = parse_filename(s);
        (r.disc, r.track, r.artist, r.title)
    }

    #[test]
    fn filename_patterns() {
        assert_eq!(p("01 - Airbag"), (None, Some(1), None, "Airbag".into()));
        assert_eq!(p("01. Airbag"), (None, Some(1), None, "Airbag".into()));
        assert_eq!(p("01 Airbag"), (None, Some(1), None, "Airbag".into()));
        assert_eq!(p("01_Airbag"), (None, Some(1), None, "Airbag".into()));
        assert_eq!(
            p("01. Radiohead - Airbag"),
            (None, Some(1), Some("Radiohead".into()), "Airbag".into())
        );
        assert_eq!(
            p("Radiohead - 01 - Airbag"),
            (None, Some(1), Some("Radiohead".into()), "Airbag".into())
        );
        assert_eq!(p("1-01 Title"), (Some(1), Some(1), None, "Title".into()));
        assert_eq!(p("2.05. Title"), (Some(2), Some(5), None, "Title".into()));
        assert_eq!(p("101 - Title"), (None, Some(101), None, "Title".into()));
        assert_eq!(p("01"), (None, Some(1), None, "".into()));
        assert_eq!(p("Track01"), (None, Some(1), None, "".into()));
        assert_eq!(p("track 12"), (None, Some(12), None, "".into()));
        assert_eq!(p("Just A Title"), (None, None, None, "Just A Title".into()));
        assert_eq!(parse_filename("01 Artist - Title").rest, "Artist - Title");
    }

    #[test]
    fn disc_dirs() {
        for (s, n) in [
            ("CD1", 1),
            ("CD 2", 2),
            ("Disc 1", 1),
            ("Disk2", 2),
            ("disc_3", 3),
            ("Диск 2", 2),
            ("CD1 [FLAC]", 1),
        ] {
            assert_eq!(disc_dir_number(s), Some(n), "{s}");
        }
        assert_eq!(disc_dir_number("Discography"), None);
        assert_eq!(disc_dir_number("Disco"), None);
        assert_eq!(disc_dir_number("OK Computer"), None);
    }

    #[test]
    fn path_helpers() {
        assert_eq!(extension("A/b.FLAC").as_deref(), Some("flac"));
        assert_eq!(stem("A/01 - x.y.flac"), "01 - x.y");
        assert_eq!(dir_of("A/B/c.mp3"), "A/B");
        assert_eq!(dir_of("c.mp3"), "");
        assert!(is_audio("x/y.Flac") && !is_audio("x/cover.jpg") && !is_audio("x/a.cue"));
    }
}
