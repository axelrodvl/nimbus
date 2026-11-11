use std::collections::HashMap;

use uuid::Uuid;

/// Краткие данные о релизе для выбора каноничного.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseBrief {
    pub mbid: Uuid,
    pub date: Option<String>,
    pub country: Option<String>,
    /// Формат каждого носителя (`None`, если не указан).
    pub formats: Vec<Option<String>>,
    pub track_count: u32,
}

/// Мода числа треков среди релизов (при равенстве — меньшее число).
pub fn mode_track_count(releases: &[ReleaseBrief]) -> Option<u32> {
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for r in releases {
        *counts.entry(r.track_count).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|&(n, c)| (c, std::cmp::Reverse(n)))
        .map(|(n, _)| n)
}

/// Балл релиза: формат (все носители Digital Media +3, все CD +2), страна (XW +2, US/GB +1),
/// число треков равно моде +3.
pub fn score_release(r: &ReleaseBrief, mode_track_count: Option<u32>) -> i32 {
    let mut score = 0;
    if !r.formats.is_empty() {
        if r.formats
            .iter()
            .all(|f| f.as_deref() == Some("Digital Media"))
        {
            score += 3;
        } else if r.formats.iter().all(|f| f.as_deref() == Some("CD")) {
            score += 2;
        }
    }
    score += match r.country.as_deref() {
        Some("XW") => 2,
        Some("US") | Some("GB") => 1,
        _ => 0,
    };
    if Some(r.track_count) == mode_track_count {
        score += 3;
    }
    score
}

/// Выбирает каноничный релиз: максимальный балл, при равенстве — самая ранняя дата
/// (релизы без даты — последними), затем mbid для детерминизма.
pub fn pick_canonical(releases: &[ReleaseBrief]) -> Option<&ReleaseBrief> {
    let mode = mode_track_count(releases);
    releases.iter().min_by(|a, b| {
        let key = |r: &ReleaseBrief| {
            (
                std::cmp::Reverse(score_release(r, mode)),
                r.date
                    .as_deref()
                    .filter(|d| !d.is_empty())
                    .unwrap_or("9999")
                    .to_string(),
                r.mbid,
            )
        };
        key(a).cmp(&key(b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(n: u128, date: &str, country: &str, formats: &[&str], tracks: u32) -> ReleaseBrief {
        ReleaseBrief {
            mbid: Uuid::from_u128(n),
            date: (!date.is_empty()).then(|| date.to_string()),
            country: (!country.is_empty()).then(|| country.to_string()),
            formats: formats.iter().map(|f| Some(f.to_string())).collect(),
            track_count: tracks,
        }
    }

    #[test]
    fn score_components() {
        let digital_xw = rel(1, "", "XW", &["Digital Media"], 12);
        assert_eq!(score_release(&digital_xw, Some(12)), 3 + 2 + 3);
        assert_eq!(score_release(&digital_xw, Some(10)), 5);
        let cd_gb = rel(2, "", "GB", &["CD"], 12);
        assert_eq!(score_release(&cd_gb, Some(12)), 2 + 1 + 3);
        let vinyl_jp = rel(3, "", "JP", &["12\" Vinyl"], 12);
        assert_eq!(score_release(&vinyl_jp, Some(12)), 3);
        let mixed = rel(4, "", "US", &["CD", "DVD-Video"], 12);
        assert_eq!(score_release(&mixed, Some(12)), 1 + 3);
        assert_eq!(score_release(&rel(5, "", "", &[], 7), Some(12)), 0);
    }

    #[test]
    fn mode_prefers_most_common_then_smaller() {
        let rs = [
            rel(1, "", "", &[], 12),
            rel(2, "", "", &[], 12),
            rel(3, "", "", &[], 25),
        ];
        assert_eq!(mode_track_count(&rs), Some(12));
        let tie = [rel(1, "", "", &[], 25), rel(2, "", "", &[], 12)];
        assert_eq!(mode_track_count(&tie), Some(12));
        assert_eq!(mode_track_count(&[]), None);
    }

    #[test]
    fn deluxe_is_filtered_out_and_earliest_wins_ties() {
        let rs = [
            rel(1, "1997-06-16", "GB", &["CD"], 12),
            rel(2, "1997-05-21", "JP", &["CD"], 12),
            rel(3, "2017-06-23", "XW", &["Digital Media"], 24), // deluxe
            rel(4, "2008-01-01", "XW", &["Digital Media"], 12),
        ];
        // digital XW 12 = 3+2+3 = 8 — лучший
        assert_eq!(pick_canonical(&rs).unwrap().mbid, Uuid::from_u128(4));
        // без цифрового релиза: GB CD (2+1+3=6) выигрывает у JP CD (2+3=5)
        assert_eq!(pick_canonical(&rs[..2]).unwrap().mbid, Uuid::from_u128(1));
        // равные баллы → самая ранняя дата
        let tie = [
            rel(5, "2001-01-01", "US", &["CD"], 10),
            rel(6, "2000-01-01", "US", &["CD"], 10),
        ];
        assert_eq!(pick_canonical(&tie).unwrap().mbid, Uuid::from_u128(6));
        // без даты — последний
        let nodate = [
            rel(7, "", "US", &["CD"], 10),
            rel(8, "2020-01-01", "US", &["CD"], 10),
        ];
        assert_eq!(pick_canonical(&nodate).unwrap().mbid, Uuid::from_u128(8));
        assert!(pick_canonical(&[]).is_none());
    }
}
