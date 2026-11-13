// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
//! Сценарии на реальных структурах раздач (`tests/fixtures/*.json`).

use std::collections::HashMap;

use nimbus_matcher::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    album: Album,
    files: Vec<String>,
    expect: Expect,
}
#[derive(Deserialize)]
struct Album {
    artist: String,
    title: String,
    year: Option<i32>,
    discs: i32,
    tracks: Vec<Tr>,
}
#[derive(Deserialize)]
struct Tr {
    disc: i32,
    title: String,
}
#[derive(Deserialize, Default)]
struct Expect {
    /// Название трека → путь файла.
    matches: HashMap<String, String>,
    /// Эти треки допустимы только на уровне «нужно подтверждение».
    #[serde(default)]
    confirm: Vec<String>,
    /// Эти треки не должны быть сопоставлены вообще.
    #[serde(default)]
    unmatched: Vec<String>,
    cue: Option<bool>,
    /// [индекс .cue, индекс образа] в списке файлов.
    cue_pair: Option<[usize; 2]>,
}

fn load() -> Vec<Fixture> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut v: Vec<Fixture> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| serde_json::from_slice(&std::fs::read(e.path()).unwrap()).unwrap())
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

#[test]
fn all_scenarios() {
    let fixtures = load();
    assert!(fixtures.len() >= 12, "нужно минимум 12 сценариев");
    let cfg = MatchConfig::default();
    let mut failures = vec![];
    let (mut accepted, mut accepted_wrong) = (0, 0);

    for f in &fixtures {
        let mut pos: HashMap<i32, i32> = HashMap::new();
        let tracks: Vec<TrackInput> = f
            .album
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let p = pos.entry(t.disc).or_insert(0);
                *p += 1;
                TrackInput {
                    id: i as i64 + 1,
                    title: t.title.clone(),
                    disc_no: t.disc,
                    position: *p,
                    duration_ms: None,
                }
            })
            .collect();
        let files: Vec<FileInput> = f
            .files
            .iter()
            .enumerate()
            .map(|(i, p)| FileInput {
                index: i,
                path: p.clone(),
                size: 30 * 1024 * 1024,
            })
            .collect();
        let album = AlbumInput {
            artist: &f.album.artist,
            title: &f.album.title,
            year: f.album.year,
            total_discs: f.album.discs,
            tracks: &tracks,
        };
        let out = match_album(&files, &album, &cfg);
        let by_title: HashMap<&str, &TrackInput> =
            tracks.iter().map(|t| (t.title.as_str(), t)).collect();
        let got: HashMap<i64, &MatchResult> = out.matches.iter().map(|m| (m.track_id, m)).collect();
        let mut fail = |msg: String| failures.push(format!("[{}] {msg}", f.name));

        // Ожидаемые сопоставления.
        for (title, path) in &f.expect.matches {
            let t = by_title[title.as_str()];
            match got.get(&t.id) {
                None => fail(format!("«{title}» не сопоставлен (ждали {path})")),
                Some(m) => {
                    let actual = &files[m.file_index].path;
                    if actual != path {
                        fail(format!(
                            "«{title}» → {actual}, ждали {path} (score {:.2})",
                            m.score
                        ));
                    }
                    let want_confirm = f.expect.confirm.contains(title);
                    if want_confirm != m.needs_confirmation {
                        fail(format!(
                            "«{title}»: needs_confirmation={} (score {:.2}), ждали {want_confirm}",
                            m.needs_confirmation, m.score
                        ));
                    }
                }
            }
        }
        // Precision: любое сопоставление с score >= accept должно быть ожидаемым.
        for m in &out.matches {
            if m.score >= cfg.accept {
                accepted += 1;
                let t = tracks.iter().find(|t| t.id == m.track_id).unwrap();
                let ok = f.expect.matches.get(&t.title) == Some(&files[m.file_index].path);
                if !ok {
                    accepted_wrong += 1;
                    fail(format!(
                        "НЕВЕРНОЕ уверенное сопоставление «{}» → {}",
                        t.title, files[m.file_index].path
                    ));
                }
            }
        }
        // Не должно быть сопоставлено вообще.
        for title in &f.expect.unmatched {
            let t = by_title[title.as_str()];
            if let Some(m) = got.get(&t.id) {
                fail(format!(
                    "«{title}» не должен совпасть, а совпал с {} ({:.2})",
                    files[m.file_index].path, m.score
                ));
            }
            if !out.unmatched_track_ids.contains(&t.id) {
                fail(format!("«{title}» отсутствует в unmatched"));
            }
        }
        if let Some(want) = f.expect.cue {
            if want != !out.cue_candidates.is_empty() {
                fail(format!("cue_candidates: {:?}", out.cue_candidates));
            }
        }
        if let Some([cue, img]) = f.expect.cue_pair {
            let ok = out
                .cue_candidates
                .iter()
                .any(|c| c.cue_file_index == cue && c.image_file_index == img);
            if !ok {
                fail(format!(
                    "нет CueCandidate ({cue}, {img}): {:?}",
                    out.cue_candidates
                ));
            }
        }
        // Каждый файл и трек — не более одного раза.
        let mut seen_f = std::collections::HashSet::new();
        for m in &out.matches {
            assert!(
                seen_f.insert(m.file_index),
                "[{}] файл {} назначен дважды",
                f.name,
                m.file_index
            );
        }
    }
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
    assert_eq!(
        accepted_wrong, 0,
        "precision должна быть 100% (всего уверенных: {accepted})"
    );
    assert!(accepted > 50);
}
