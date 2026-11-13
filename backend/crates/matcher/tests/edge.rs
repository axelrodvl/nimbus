// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use nimbus_matcher::*;

fn tr(id: i64, title: &str, disc: i32, pos: i32) -> TrackInput {
    TrackInput {
        id,
        title: title.into(),
        disc_no: disc,
        position: pos,
        duration_ms: None,
    }
}

fn files(paths: &[&str]) -> Vec<FileInput> {
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| FileInput {
            index: i,
            path: p.to_string(),
            size: 1 << 25,
        })
        .collect()
}

fn album<'a>(tracks: &'a [TrackInput], discs: i32) -> AlbumInput<'a> {
    AlbumInput {
        artist: "Artist",
        title: "Record",
        year: None,
        total_discs: discs,
        tracks,
    }
}

#[test]
fn empty_inputs() {
    let cfg = MatchConfig::default();
    let tracks = [tr(1, "A", 1, 1)];
    let out = match_album(&[], &album(&tracks, 1), &cfg);
    assert!(out.matches.is_empty() && out.unmatched_track_ids == [1]);
    let out = match_album(&files(&["x/01 - A.flac"]), &album(&[], 1), &cfg);
    assert!(out.matches.is_empty() && out.unmatched_track_ids.is_empty());
    // Только неаудио.
    let out = match_album(
        &files(&["x/cover.jpg", "x/info.nfo"]),
        &album(&tracks, 1),
        &cfg,
    );
    assert_eq!(out.unmatched_track_ids, [1]);
}

#[test]
fn hundred_style_numbering_for_multidisc() {
    let tracks = [
        tr(1, "Alpha", 1, 1),
        tr(2, "Bravo", 1, 2),
        tr(3, "Charlie", 2, 1),
        tr(4, "Delta", 2, 2),
    ];
    let fs = files(&[
        "Artist - Record/101 - Alpha.flac",
        "Artist - Record/102 - Bravo.flac",
        "Artist - Record/201 - Charlie.flac",
        "Artist - Record/202 - Delta.flac",
    ]);
    let out = match_album(&fs, &album(&tracks, 2), &MatchConfig::default());
    assert_eq!(out.matches.len(), 4);
    for m in &out.matches {
        assert_eq!(m.file_index as i64, m.track_id - 1);
        assert!(!m.needs_confirmation, "{m:?}");
    }
}

#[test]
fn identical_titles_are_resolved_by_position() {
    let tracks = [
        tr(1, "Interlude", 1, 1),
        tr(2, "Song", 1, 2),
        tr(3, "Interlude", 1, 3),
    ];
    let fs = files(&[
        "Artist - Record/01 - Interlude.flac",
        "Artist - Record/02 - Song.flac",
        "Artist - Record/03 - Interlude.flac",
    ]);
    let out = match_album(&fs, &album(&tracks, 1), &MatchConfig::default());
    assert_eq!(out.matches.len(), 3);
    for m in &out.matches {
        assert_eq!(m.file_index as i64, m.track_id - 1, "{m:?}");
    }
}

#[test]
fn extension_case_and_unnumbered_files() {
    let tracks = [tr(1, "Alpha Beta", 1, 1), tr(2, "Gamma Delta", 1, 2)];
    let fs = files(&[
        "Artist - Record/Alpha Beta.FLAC",
        "Artist - Record/Gamma Delta.Flac",
    ]);
    let out = match_album(&fs, &album(&tracks, 1), &MatchConfig::default());
    assert_eq!(out.matches.len(), 2);
    // Без номеров позиция не совпала: score ниже 1.0 по позиции, но название точное.
    assert!(out.matches.iter().all(|m| m.score >= 0.7));
}

#[test]
fn files_at_torrent_root() {
    let tracks = [tr(1, "Alpha", 1, 1), tr(2, "Bravo", 1, 2)];
    let fs = files(&["01 - Alpha.flac", "02 - Bravo.flac"]);
    let out = match_album(&fs, &album(&tracks, 1), &MatchConfig::default());
    assert_eq!(out.matches.len(), 2);
    assert!(out.matches.iter().all(|m| !m.needs_confirmation));
}

#[test]
fn thresholds_are_configurable() {
    let tracks = [tr(1, "Alpha", 1, 1)];
    let fs = files(&["Artist - Record/01 - Alpha.flac"]);
    let cfg = MatchConfig {
        accept: 1.1,
        ..MatchConfig::default()
    };
    let out = match_album(&fs, &album(&tracks, 1), &cfg);
    assert_eq!(out.matches.len(), 1);
    assert!(out.matches[0].needs_confirmation);
    let cfg = MatchConfig {
        confirm: 1.1,
        accept: 1.1,
        ..MatchConfig::default()
    };
    assert!(match_album(&fs, &album(&tracks, 1), &cfg)
        .matches
        .is_empty());
}
