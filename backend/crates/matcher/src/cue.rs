//! Разбор CUE-файлов и сопоставление их треков с треками альбома.

use std::sync::OnceLock;

use regex::Regex;

use crate::normalize::{norm, similarity};
use crate::{AlbumInput, TrackInput};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CueSheet {
    pub performer: Option<String>,
    pub title: Option<String>,
    pub files: Vec<CueFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueFile {
    pub name: String,
    pub tracks: Vec<CueTrack>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueTrack {
    pub number: u32,
    pub title: Option<String>,
    pub performer: Option<String>,
    /// `INDEX 01 mm:ss:ff` (ff — 1/75 секунды).
    pub start_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CueError {
    #[error("cue sheet contains no tracks")]
    NoTracks,
    #[error("syntax error on line {0}")]
    Syntax(usize),
}

/// UTF-8 (в том числе с BOM), иначе cp1251 — частый случай для RU-раздач.
pub fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
    }
}

/// Значение команды: строка в кавычках или первое слово.
fn arg(rest: &str) -> String {
    let rest = rest.trim();
    if let Some(r) = rest.strip_prefix('"') {
        r.split('"').next().unwrap_or("").to_string()
    } else {
        rest.split_whitespace().next().unwrap_or("").to_string()
    }
}

fn parse_time(s: &str) -> Option<u32> {
    let mut it = s.split(':');
    let (m, sec, f): (u32, u32, u32) = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    Some((m * 60 + sec) * 1000 + f * 1000 / 75)
}

pub fn parse_cue(bytes: &[u8]) -> Result<CueSheet, CueError> {
    static LINE: OnceLock<Regex> = OnceLock::new();
    let line_re = LINE.get_or_init(|| Regex::new(r"^\s*([A-Za-z]+)\s*(.*)$").expect("valid regex"));
    let text = decode(bytes);
    let mut sheet = CueSheet::default();
    let mut current: Option<CueTrack> = None;

    fn finish(sheet: &mut CueSheet, t: Option<CueTrack>) {
        if let (Some(t), Some(f)) = (t, sheet.files.last_mut()) {
            f.tracks.push(t);
        }
    }

    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(c) = line_re.captures(line) else {
            continue; // например, REM с нестандартным началом
        };
        let (cmd, rest) = (c[1].to_ascii_uppercase(), &c[2]);
        match cmd.as_str() {
            "FILE" => {
                finish(&mut sheet, current.take());
                sheet.files.push(CueFile {
                    name: arg(rest),
                    tracks: vec![],
                });
            }
            "TRACK" => {
                finish(&mut sheet, current.take());
                if sheet.files.is_empty() {
                    return Err(CueError::Syntax(n + 1));
                }
                let number = rest
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or(CueError::Syntax(n + 1))?;
                current = Some(CueTrack {
                    number,
                    title: None,
                    performer: None,
                    start_ms: 0,
                });
            }
            "TITLE" => match current.as_mut() {
                Some(t) => t.title = Some(arg(rest)),
                None => sheet.title = Some(arg(rest)),
            },
            "PERFORMER" => match current.as_mut() {
                Some(t) => t.performer = Some(arg(rest)),
                None => sheet.performer = Some(arg(rest)),
            },
            "INDEX" => {
                let mut it = rest.split_whitespace();
                if let (Some("01"), Some(time), Some(t)) = (it.next(), it.next(), current.as_mut())
                {
                    t.start_ms = parse_time(time).ok_or(CueError::Syntax(n + 1))?;
                }
            }
            _ => {}
        }
    }
    finish(&mut sheet, current.take());
    if sheet.files.iter().all(|f| f.tracks.is_empty()) {
        return Err(CueError::NoTracks);
    }
    Ok(sheet)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueMatch {
    pub track_id: i64,
    /// Имя аудиофайла из строки `FILE`.
    pub file_name: String,
    pub start_ms: u32,
    /// Начало следующего трека в том же `FILE`; `None` — до конца файла.
    pub end_ms: Option<u32>,
}

struct Flat<'a> {
    file: &'a str,
    start_ms: u32,
    end_ms: Option<u32>,
    title: Option<&'a str>,
}

/// Сопоставляет треки CUE с треками альбома: по порядку, если число треков совпало
/// (и названия не противоречат), иначе по сходству названий.
pub fn match_cue(sheet: &CueSheet, album: &AlbumInput) -> Vec<CueMatch> {
    let flat: Vec<Flat> = sheet
        .files
        .iter()
        .flat_map(|f| {
            f.tracks.iter().enumerate().map(|(i, t)| Flat {
                file: &f.name,
                start_ms: t.start_ms,
                end_ms: f.tracks.get(i + 1).map(|n| n.start_ms),
                title: t.title.as_deref(),
            })
        })
        .collect();
    let mut tracks: Vec<&TrackInput> = album.tracks.iter().collect();
    tracks.sort_by_key(|t| (t.disc_no, t.position));

    let to_match = |t: &TrackInput, f: &Flat| CueMatch {
        track_id: t.id,
        file_name: f.file.to_string(),
        start_ms: f.start_ms,
        end_ms: f.end_ms,
    };
    let sim = |t: &TrackInput, f: &Flat| {
        f.title
            .map(|ft| similarity(&norm(ft), &norm(&t.title)))
            .unwrap_or(0.0)
    };

    if flat.len() == tracks.len() {
        let titled: Vec<f32> = tracks
            .iter()
            .zip(&flat)
            .filter(|(_, f)| f.title.is_some())
            .map(|(t, f)| sim(t, f))
            .collect();
        let avg = if titled.is_empty() {
            1.0
        } else {
            titled.iter().sum::<f32>() / titled.len() as f32
        };
        if avg >= 0.5 {
            return tracks
                .iter()
                .zip(&flat)
                .map(|(t, f)| to_match(t, f))
                .collect();
        }
    }

    // По названиям, жадно.
    let mut pairs: Vec<(f32, usize, usize)> = vec![];
    for (ti, t) in tracks.iter().enumerate() {
        for (fi, f) in flat.iter().enumerate() {
            let s = sim(t, f);
            if s >= 0.7 {
                pairs.push((s, ti, fi));
            }
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let (mut used_t, mut used_f) = (vec![false; tracks.len()], vec![false; flat.len()]);
    let mut out = vec![];
    for (_, ti, fi) in pairs {
        if used_t[ti] || used_f[fi] {
            continue;
        }
        used_t[ti] = true;
        used_f[fi] = true;
        out.push(to_match(tracks[ti], &flat[fi]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "REM GENRE Rock\r\nPERFORMER \"Radiohead\"\r\nTITLE \"OK Computer\"\r\nFILE \"OK Computer.flac\" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE \"Airbag\"\r\n    PERFORMER \"Radiohead\"\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    TITLE \"Paranoid Android\"\r\n    INDEX 00 04:30:00\r\n    INDEX 01 04:32:45\r\n  TRACK 03 AUDIO\r\n    TITLE \"Subterranean Homesick Alien\"\r\n    INDEX 01 10:00:37\r\n";

    fn album<'a>(tracks: &'a [TrackInput]) -> AlbumInput<'a> {
        AlbumInput {
            artist: "Radiohead",
            title: "OK Computer",
            year: Some(1997),
            total_discs: 1,
            tracks,
        }
    }

    fn tr(id: i64, title: &str, pos: i32) -> TrackInput {
        TrackInput {
            id,
            title: title.into(),
            disc_no: 1,
            position: pos,
            duration_ms: None,
        }
    }

    #[test]
    fn parses_utf8_with_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(SAMPLE.as_bytes());
        let s = parse_cue(&bytes).unwrap();
        assert_eq!(s.performer.as_deref(), Some("Radiohead"));
        assert_eq!(s.title.as_deref(), Some("OK Computer"));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].name, "OK Computer.flac");
        let t = &s.files[0].tracks;
        assert_eq!(t.len(), 3);
        // INDEX 01 04:32:45 → (4*60+32)*1000 + 45*1000/75 = 272600
        assert_eq!(t[1].start_ms, 272_600);
        assert_eq!(t[1].title.as_deref(), Some("Paranoid Android"));
        assert_eq!(t[0].performer.as_deref(), Some("Radiohead"));
        assert_eq!(t[2].start_ms, 600_000 + 37 * 1000 / 75);
    }

    #[test]
    fn parses_cp1251() {
        let text = "PERFORMER \"Кино\"\nTITLE \"Группа крови\"\nFILE \"Кино - Группа крови.flac\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"Группа крови\"\n    INDEX 01 00:00:00\n";
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode(text);
        let s = parse_cue(&bytes).unwrap();
        assert_eq!(s.performer.as_deref(), Some("Кино"));
        assert_eq!(s.files[0].name, "Кино - Группа крови.flac");
        assert_eq!(s.files[0].tracks[0].title.as_deref(), Some("Группа крови"));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_cue(b"hello world"), Err(CueError::NoTracks));
        assert_eq!(parse_cue(b"TRACK 01 AUDIO\n"), Err(CueError::Syntax(1)));
        assert!(parse_cue(b"FILE \"a.flac\" WAVE\n TRACK 01 AUDIO\n INDEX 01 xx\n").is_err());
    }

    #[test]
    fn unquoted_values_and_multiple_files() {
        let text = "FILE a.flac WAVE\n TRACK 01 AUDIO\n  INDEX 01 00:00:00\n TRACK 02 AUDIO\n  INDEX 01 03:00:00\nFILE b.flac WAVE\n TRACK 03 AUDIO\n  INDEX 01 00:00:00\n";
        let s = parse_cue(text.as_bytes()).unwrap();
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[1].name, "b.flac");
        assert_eq!(s.files[0].tracks.len(), 2);
    }

    #[test]
    fn matches_by_order_with_end_times() {
        let s = parse_cue(SAMPLE.as_bytes()).unwrap();
        let tracks = [
            tr(1, "Airbag", 1),
            tr(2, "Paranoid Android", 2),
            tr(3, "Subterranean Homesick Alien", 3),
        ];
        let m = match_cue(&s, &album(&tracks));
        assert_eq!(m.len(), 3);
        assert_eq!(
            (m[0].track_id, m[0].start_ms, m[0].end_ms),
            (1, 0, Some(272_600))
        );
        assert_eq!((m[1].track_id, m[1].end_ms), (2, Some(600_493)));
        assert_eq!(m[2].end_ms, None);
        assert_eq!(m[2].file_name, "OK Computer.flac");
    }

    #[test]
    fn matches_by_title_when_counts_differ() {
        let s = parse_cue(SAMPLE.as_bytes()).unwrap();
        // В альбоме 4 трека, в CUE — 3: сопоставляем по названиям.
        let tracks = [
            tr(1, "Airbag", 1),
            tr(2, "Paranoid Android", 2),
            tr(3, "Subterranean Homesick Alien", 3),
            tr(4, "Exit Music (For a Film)", 4),
        ];
        let m = match_cue(&s, &album(&tracks));
        let ids: Vec<i64> = m.iter().map(|m| m.track_id).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&1) && ids.contains(&2) && ids.contains(&3));
    }

    #[test]
    fn foreign_cue_matches_nothing() {
        let s = parse_cue(SAMPLE.as_bytes()).unwrap();
        let tracks = [
            tr(1, "Creep", 1),
            tr(2, "Anyone Can Play Guitar", 2),
            tr(3, "Stop Whispering", 3),
        ];
        assert!(match_cue(&s, &album(&tracks)).is_empty());
    }
}
