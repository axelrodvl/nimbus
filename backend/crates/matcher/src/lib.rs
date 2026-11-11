//! Сопоставление файлов раздачи с треками альбома. Чистый крейт: без I/O и БД.

pub mod cue;
pub mod filename;
pub mod normalize;

use std::collections::{BTreeMap, HashSet};

use filename::{dir_of, disc_dir_number, extension, is_audio, parse_filename, stem, ParsedName};
use normalize::{norm, similarity, Norm};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInput {
    pub index: usize,
    /// Путь через `/`, внутри торрента.
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackInput {
    pub id: i64,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct AlbumInput<'a> {
    pub artist: &'a str,
    pub title: &'a str,
    pub year: Option<i32>,
    pub total_discs: i32,
    pub tracks: &'a [TrackInput],
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchResult {
    pub track_id: i64,
    pub file_index: usize,
    pub score: f32,
    pub needs_confirmation: bool,
}

/// Предпочтение форматов по расширению: раньше в списке — лучше.
#[derive(Debug, Clone)]
pub struct FormatPrefs {
    pub order: Vec<String>,
}

impl Default for FormatPrefs {
    fn default() -> Self {
        let order = [
            "flac", "alac", "wv", "ape", "wav", "aiff", "dsf", "dff", "m4a", "opus", "ogg", "mp3",
            "aac",
        ];
        Self {
            order: order.iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl FormatPrefs {
    /// 0..1: 1 — самый предпочтительный формат.
    fn score(&self, ext: &str) -> f32 {
        match self.order.iter().position(|e| e == ext) {
            Some(i) => 1.0 - i as f32 / self.order.len() as f32,
            None => 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MatchConfig {
    /// Порог уверенного совпадения.
    pub accept: f32,
    /// Порог совпадения «с подтверждением» (`needs_confirmation`).
    pub confirm: f32,
    pub prefer: FormatPrefs,
}

impl Default for MatchConfig {
    fn default() -> Self {
        Self {
            accept: 0.80,
            confirm: 0.65,
            prefer: FormatPrefs::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CueCandidate {
    pub cue_file_index: usize,
    pub image_file_index: usize,
    pub dir: String,
}

#[derive(Debug, Clone, Default)]
pub struct MatchOutcome {
    /// Сопоставления с `score >= confirm`; `needs_confirmation = score < accept`.
    pub matches: Vec<MatchResult>,
    pub unmatched_track_ids: Vec<i64>,
    /// «Образ + cue»: разбирает шаг 21.
    pub cue_candidates: Vec<CueCandidate>,
}

// Веса оценки пары (track, file).
const W_TITLE: f32 = 0.60;
const W_POS: f32 = 0.20;
const W_DIR: f32 = 0.10;
const W_FORMAT: f32 = 0.10;
/// Порог каталога-кандидата и максимальное их число.
const DIR_MIN_SCORE: f32 = 0.5;
const MAX_DIR_CANDIDATES: usize = 3;
/// Оценка «файлов без названий», когда совпали номер и число файлов.
const NAMELESS_SCORE: f32 = 0.7;
/// Бонусы каталога.
const DIR_YEAR_BONUS: f32 = 0.1;
const DIR_COUNT_BONUS: f32 = 0.1;
/// Сколько файлов может отличаться от числа треков, чтобы дать бонус каталогу.
const DIR_COUNT_TOLERANCE: usize = 2;

struct FileCtx<'a> {
    input: &'a FileInput,
    ext: String,
    disc: Option<u32>,
    track: Option<u32>,
    /// Варианты названия для сравнения: само название и «исполнитель - название».
    titles: Vec<Norm>,
    nameless: bool,
}

/// Группа файлов одного альбома: каталог (диски `CD1`/`CD2` объединены с родителем).
struct Group<'a> {
    dir: String,
    files: Vec<FileCtx<'a>>,
    score: f32,
}

fn last_components(dir: &str, n: usize) -> String {
    let parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(n)..].join(" ")
}

fn dir_score(dir: &str, album: &AlbumInput, album_norm: &Norm, audio_count: usize) -> f32 {
    let mut s = 0.0f32;
    for n in 1..=2 {
        let name = last_components(dir, n);
        if !name.is_empty() {
            s = s.max(similarity(&norm(&name), album_norm));
        }
    }
    if let Some(y) = album.year {
        if last_components(dir, 2)
            .split(|c: char| !c.is_ascii_digit())
            .any(|w| w == y.to_string())
        {
            s += DIR_YEAR_BONUS;
        }
    }
    if audio_count.abs_diff(album.tracks.len()) <= DIR_COUNT_TOLERANCE {
        s += DIR_COUNT_BONUS;
    }
    s.min(1.0)
}

fn build_file_ctx<'a>(f: &'a FileInput, dir_disc: Option<u32>, album: &AlbumInput) -> FileCtx<'a> {
    let ParsedName {
        disc,
        mut track,
        title,
        rest,
        ..
    } = parse_filename(stem(&f.path));
    let mut disc = dir_disc.or(disc);
    // «101» при нескольких дисках — диск 1, трек 01.
    if let Some(t) = track {
        if t >= 101 && album.total_discs > 1 && disc.is_none() {
            disc = Some(t / 100);
            track = Some(t % 100);
        }
    }
    let mut titles = vec![];
    if !title.is_empty() {
        titles.push(norm(&title));
        if rest != title {
            titles.push(norm(&rest));
        }
    }
    FileCtx {
        input: f,
        ext: extension(&f.path).unwrap_or_default(),
        disc,
        track,
        nameless: title.is_empty() && track.is_some(),
        titles,
    }
}

fn position_match(file: &FileCtx, track: &TrackInput, total_discs: i32) -> f32 {
    match file.track {
        Some(n) if n as i32 == track.position => {
            if total_discs <= 1 {
                1.0
            } else {
                match file.disc {
                    Some(d) if d as i32 == track.disc_no => 1.0,
                    Some(_) => 0.0,
                    None => 0.5,
                }
            }
        }
        _ => 0.0,
    }
}

struct Scored {
    track: usize,
    file: usize, // индекс в плоском списке файлов
    score: f32,
}

/// Находит для каждого трека альбома лучший аудиофайл раздачи.
pub fn match_album(files: &[FileInput], album: &AlbumInput, cfg: &MatchConfig) -> MatchOutcome {
    let album_norm = norm(album.title);
    let track_norms: Vec<Norm> = album.tracks.iter().map(|t| norm(&t.title)).collect();

    // 1. Аудио и .cue.
    let audio: Vec<&FileInput> = files.iter().filter(|f| is_audio(&f.path)).collect();
    let cues: Vec<&FileInput> = files
        .iter()
        .filter(|f| extension(&f.path).as_deref() == Some("cue"))
        .collect();

    // 2. Группировка по каталогам альбома (диски объединяются с родителем).
    let mut by_dir: BTreeMap<String, Vec<(&FileInput, Option<u32>)>> = BTreeMap::new();
    for f in &audio {
        let dir = dir_of(&f.path);
        let (last, parent) = match dir.rsplit_once('/') {
            Some((p, l)) => (l, p),
            None => (dir, ""),
        };
        match disc_dir_number(last) {
            Some(n) if !last.is_empty() => by_dir
                .entry(parent.to_string())
                .or_default()
                .push((f, Some(n))),
            _ => by_dir.entry(dir.to_string()).or_default().push((f, None)),
        }
    }
    let single_dir = by_dir.len() == 1;
    let mut groups: Vec<Group> = by_dir
        .into_iter()
        .map(|(dir, fs)| {
            let mut score = dir_score(&dir, album, &album_norm, fs.len());
            if single_dir {
                score = score.max(DIR_MIN_SCORE);
            }
            Group {
                files: fs
                    .into_iter()
                    .map(|(f, d)| build_file_ctx(f, d, album))
                    .collect(),
                dir,
                score,
            }
        })
        .filter(|g| g.score >= DIR_MIN_SCORE)
        .collect();
    groups.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.dir.cmp(&b.dir)));
    groups.truncate(MAX_DIR_CANDIDATES);

    // 3. CUE-образы: 1–3 аудиофайла + .cue, а треков в альбоме больше.
    let mut cue_candidates = vec![];
    let mut image_files: HashSet<usize> = HashSet::new();
    for g in &groups {
        if g.files.len() > 3 || g.files.len() >= album.tracks.len() {
            continue;
        }
        // Физические каталоги группы (диски лежат в подкаталогах).
        let mut dirs: Vec<&str> = g.files.iter().map(|f| dir_of(&f.input.path)).collect();
        dirs.sort_unstable();
        dirs.dedup();
        for d in dirs {
            let dir_cues: Vec<&&FileInput> = cues.iter().filter(|c| dir_of(&c.path) == d).collect();
            if dir_cues.is_empty() {
                continue;
            }
            for f in g.files.iter().filter(|f| dir_of(&f.input.path) == d) {
                let same_stem = dir_cues
                    .iter()
                    .find(|c| stem(&c.path).eq_ignore_ascii_case(stem(&f.input.path)));
                let cue = same_stem.or(if dir_cues.len() == 1 {
                    dir_cues.first()
                } else {
                    None
                });
                if let Some(c) = cue {
                    cue_candidates.push(CueCandidate {
                        cue_file_index: c.index,
                        image_file_index: f.input.index,
                        dir: d.to_string(),
                    });
                    image_files.insert(f.input.index);
                }
            }
        }
    }

    // 4. Оценка пар (track, file) по всем группам-кандидатам.
    let flat: Vec<(&FileCtx, &Group)> = groups
        .iter()
        .flat_map(|g| g.files.iter().map(move |f| (f, g)))
        .filter(|(f, _)| !image_files.contains(&f.input.index))
        .collect();

    let mut pairs: Vec<Scored> = vec![];
    for (ti, track) in album.tracks.iter().enumerate() {
        for (fi, (file, group)) in flat.iter().enumerate() {
            let title_sim = file
                .titles
                .iter()
                .map(|t| similarity(t, &track_norms[ti]))
                .fold(0.0f32, f32::max);
            let pos = position_match(file, track, album.total_discs);
            let fmt = cfg.prefer.score(&file.ext);
            let mut score =
                W_TITLE * title_sim + W_POS * pos + W_DIR * group.score + W_FORMAT * fmt;
            // Файлы без названий (`01.flac`): совпали номер и число файлов в каталоге.
            if title_sim < 0.5
                && pos >= 1.0
                && group.files.len() == album.tracks.len()
                && (file.nameless || group.score >= DIR_MIN_SCORE)
                && (file.nameless || file.titles.is_empty())
            {
                score = score.max(NAMELESS_SCORE);
            }
            if score >= cfg.confirm {
                pairs.push(Scored {
                    track: ti,
                    file: fi,
                    score,
                });
            }
        }
    }

    // 5. Жадное назначение по убыванию оценки.
    pairs.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.track.cmp(&b.track))
            .then(flat[a.file].0.input.index.cmp(&flat[b.file].0.input.index))
    });
    let mut used_t = vec![false; album.tracks.len()];
    let mut used_f = vec![false; flat.len()];
    let mut chosen: Vec<(usize, MatchResult)> = vec![];
    for p in pairs {
        if used_t[p.track] || used_f[p.file] {
            continue;
        }
        used_t[p.track] = true;
        used_f[p.file] = true;
        chosen.push((
            p.track,
            MatchResult {
                track_id: album.tracks[p.track].id,
                file_index: flat[p.file].0.input.index,
                score: p.score,
                needs_confirmation: p.score < cfg.accept,
            },
        ));
    }
    chosen.sort_by_key(|(t, _)| *t);
    let unmatched_track_ids = album
        .tracks
        .iter()
        .enumerate()
        .filter(|(i, _)| !used_t[*i])
        .map(|(_, t)| t.id)
        .collect();
    MatchOutcome {
        matches: chosen.into_iter().map(|(_, m)| m).collect(),
        unmatched_track_ids,
        cue_candidates,
    }
}
