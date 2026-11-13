//! Сырые модели ответов MB (только нужные поля) и публичные доменные структуры.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::canonical::ReleaseBrief;
use crate::error::MbError;

// ------------------------------------------------------------------ публичные типы

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtistHit {
    pub mbid: Uuid,
    pub name: String,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
    pub country: Option<String>,
    pub score: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseGroupHit {
    pub mbid: Uuid,
    pub title: String,
    pub artist_mbid: Uuid,
    pub artist_name: String,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub year: Option<i32>,
    pub score: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordingHit {
    pub mbid: Uuid,
    pub title: String,
    pub artist_mbid: Uuid,
    pub artist_name: String,
    pub duration_ms: Option<u32>,
    pub release_group_mbid: Option<Uuid>,
    pub album_title: Option<String>,
    pub score: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseTracklist {
    pub release_mbid: Uuid,
    pub tracks: Vec<TrackItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrackItem {
    pub mbid_track: Uuid,
    pub mbid_recording: Uuid,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<u32>,
}

// ------------------------------------------------------------------ сырые типы

#[derive(Debug, Deserialize)]
pub(crate) struct SearchArtists {
    #[serde(default)]
    pub artists: Vec<RawArtist>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SearchReleaseGroups {
    #[serde(default, rename = "release-groups")]
    pub release_groups: Vec<RawReleaseGroup>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SearchRecordings {
    #[serde(default)]
    pub recordings: Vec<RawRecording>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BrowseReleaseGroups {
    #[serde(default, rename = "release-group-count")]
    pub count: usize,
    #[serde(default, rename = "release-groups")]
    pub release_groups: Vec<RawReleaseGroup>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BrowseReleases {
    #[serde(default, rename = "release-count")]
    pub count: usize,
    #[serde(default)]
    pub releases: Vec<RawRelease>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawArtist {
    pub id: Uuid,
    pub name: String,
    #[serde(default, rename = "sort-name")]
    pub sort_name: Option<String>,
    #[serde(default)]
    pub disambiguation: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub score: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawCredit {
    pub artist: RawCreditArtist,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawCreditArtist {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawReleaseGroup {
    pub id: Uuid,
    pub title: String,
    #[serde(default, rename = "primary-type")]
    pub primary_type: Option<String>,
    #[serde(default, rename = "secondary-types")]
    pub secondary_types: Vec<String>,
    #[serde(default, rename = "first-release-date")]
    pub first_release_date: Option<String>,
    #[serde(default)]
    pub score: Option<u32>,
    #[serde(default, rename = "artist-credit")]
    pub artist_credit: Vec<RawCredit>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawRecording {
    pub id: Uuid,
    pub title: String,
    #[serde(default)]
    pub length: Option<u32>,
    #[serde(default)]
    pub score: Option<u32>,
    #[serde(default, rename = "artist-credit")]
    pub artist_credit: Vec<RawCredit>,
    #[serde(default)]
    pub releases: Vec<RawRecRelease>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawRecRelease {
    #[allow(dead_code)]
    pub id: Uuid,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default, rename = "release-group")]
    pub release_group: Option<RawRgRef>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawRgRef {
    pub id: Uuid,
    pub title: String,
    #[serde(default, rename = "primary-type")]
    pub primary_type: Option<String>,
    #[serde(default, rename = "secondary-types")]
    pub secondary_types: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawRelease {
    pub id: Uuid,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub media: Vec<RawMedium>,
    /// Только при `inc=release-groups`: к какой группе относится релиз.
    #[serde(default, rename = "release-group")]
    pub release_group: Option<RawGroupId>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawGroupId {
    pub id: Uuid,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawMedium {
    #[serde(default)]
    pub position: Option<i32>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default, rename = "track-count")]
    pub track_count: u32,
    #[serde(default)]
    pub tracks: Vec<RawTrack>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawTrack {
    pub id: Uuid,
    #[serde(default)]
    pub position: i32,
    pub title: String,
    #[serde(default)]
    pub length: Option<u32>,
    pub recording: RawTrackRecording,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawTrackRecording {
    pub id: Uuid,
    #[serde(default)]
    pub length: Option<u32>,
}

// ------------------------------------------------------------------ конвертация

fn score(s: Option<u32>) -> u8 {
    s.unwrap_or(100).min(100) as u8
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

/// Год — первые 4 символа даты.
fn year(date: Option<&str>) -> Option<i32> {
    date?.get(..4)?.parse().ok()
}

impl From<RawArtist> for ArtistHit {
    fn from(a: RawArtist) -> Self {
        Self {
            mbid: a.id,
            name: a.name,
            sort_name: non_empty(a.sort_name),
            disambiguation: non_empty(a.disambiguation),
            country: non_empty(a.country),
            score: score(a.score),
        }
    }
}

impl RawReleaseGroup {
    /// `fallback_artist` — артист из запроса (browse), если в ответе нет `artist-credit`.
    pub(crate) fn into_hit(
        self,
        fallback_artist: Option<Uuid>,
    ) -> Result<ReleaseGroupHit, MbError> {
        let (artist_mbid, artist_name) = match self.artist_credit.into_iter().next() {
            Some(c) => (c.artist.id, c.artist.name),
            None => (
                fallback_artist.ok_or_else(|| {
                    MbError::Parse(format!("release group {} has no artist-credit", self.id))
                })?,
                String::new(),
            ),
        };
        Ok(ReleaseGroupHit {
            mbid: self.id,
            title: self.title,
            artist_mbid,
            artist_name,
            primary_type: non_empty(self.primary_type),
            secondary_types: self.secondary_types,
            year: year(self.first_release_date.as_deref()),
            score: score(self.score),
        })
    }
}

/// Приоритет типа группы: Album без secondary types (0) > EP (1) > Single (2) > остальное (3).
fn rg_rank(rg: &RawRgRef) -> u8 {
    match rg.primary_type.as_deref() {
        Some("Album") if rg.secondary_types.is_empty() => 0,
        Some("EP") => 1,
        Some("Single") => 2,
        _ => 3,
    }
}

/// Выбирает релиз, чья release group лучше всего подходит как «альбом» записи:
/// по рангу типа, затем Official раньше прочих, затем самая ранняя дата.
pub(crate) fn pick_release_group(releases: &[RawRecRelease]) -> Option<&RawRgRef> {
    releases
        .iter()
        .filter_map(|r| r.release_group.as_ref().map(|rg| (r, rg)))
        .min_by_key(|(r, rg)| {
            (
                rg_rank(rg),
                r.status.as_deref() != Some("Official"),
                r.date
                    .clone()
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| "9999".into()),
            )
        })
        .map(|(_, rg)| rg)
}

impl RawRecording {
    pub(crate) fn into_hit(self) -> Result<RecordingHit, MbError> {
        let chosen = pick_release_group(&self.releases).map(|rg| (rg.id, rg.title.clone()));
        let credit =
            self.artist_credit.into_iter().next().ok_or_else(|| {
                MbError::Parse(format!("recording {} has no artist-credit", self.id))
            })?;
        Ok(RecordingHit {
            mbid: self.id,
            title: self.title,
            artist_mbid: credit.artist.id,
            artist_name: credit.artist.name,
            duration_ms: self.length,
            release_group_mbid: chosen.as_ref().map(|c| c.0),
            album_title: chosen.map(|c| c.1),
            score: score(self.score),
        })
    }
}

impl RawRelease {
    pub(crate) fn brief(&self) -> ReleaseBrief {
        ReleaseBrief {
            mbid: self.id,
            date: non_empty(self.date.clone()),
            country: non_empty(self.country.clone()),
            track_count: self.media.iter().map(|m| m.track_count).sum(),
            formats: self.media.iter().map(|m| m.format.clone()).collect(),
        }
    }

    pub(crate) fn into_brief(self) -> ReleaseBrief {
        ReleaseBrief {
            mbid: self.id,
            date: non_empty(self.date),
            country: non_empty(self.country),
            track_count: self.media.iter().map(|m| m.track_count).sum(),
            formats: self.media.into_iter().map(|m| m.format).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawReleaseFull {
    pub id: Uuid,
    #[serde(default)]
    pub media: Vec<RawMedium>,
}

impl RawRelease {
    /// Все ли дорожки на месте (browse с `recordings` может отдать носитель не целиком).
    pub(crate) fn has_complete_tracklist(&self) -> bool {
        !self.media.is_empty()
            && self
                .media
                .iter()
                .all(|m| m.tracks.len() as u32 == m.track_count)
    }
}

impl From<RawReleaseFull> for ReleaseTracklist {
    fn from(r: RawReleaseFull) -> Self {
        let mut tracks = Vec::new();
        for (i, m) in r.media.into_iter().enumerate() {
            let disc_no = m.position.unwrap_or(i as i32 + 1);
            for t in m.tracks {
                tracks.push(TrackItem {
                    mbid_track: t.id,
                    mbid_recording: t.recording.id,
                    title: t.title,
                    disc_no,
                    position: t.position,
                    duration_ms: t.length.or(t.recording.length),
                });
            }
        }
        Self {
            release_mbid: r.id,
            tracks,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec_release(
        status: &str,
        date: &str,
        ty: &str,
        secondary: &[&str],
        n: u128,
    ) -> RawRecRelease {
        RawRecRelease {
            id: Uuid::from_u128(n),
            status: Some(status.into()),
            date: Some(date.into()),
            release_group: Some(RawRgRef {
                id: Uuid::from_u128(1000 + n),
                title: format!("rg{n}"),
                primary_type: Some(ty.into()),
                secondary_types: secondary.iter().map(|s| s.to_string()).collect(),
            }),
        }
    }

    #[test]
    fn release_group_priority() {
        let rs = vec![
            rec_release("Official", "1990-01-01", "Single", &[], 1),
            rec_release("Official", "1995-01-01", "Album", &["Compilation"], 2),
            rec_release("Official", "1997-01-01", "EP", &[], 3),
            rec_release("Official", "1999-01-01", "Album", &[], 4),
        ];
        assert_eq!(pick_release_group(&rs).unwrap().title, "rg4");
        assert_eq!(pick_release_group(&rs[..3]).unwrap().title, "rg3");
        assert_eq!(pick_release_group(&rs[..1]).unwrap().title, "rg1");
        assert_eq!(pick_release_group(&rs[1..2]).unwrap().title, "rg2");
        assert!(pick_release_group(&[]).is_none());
    }

    #[test]
    fn official_then_earliest_within_rank() {
        let rs = vec![
            rec_release("Bootleg", "1990-01-01", "Album", &[], 1),
            rec_release("Official", "2005-01-01", "Album", &[], 2),
            rec_release("Official", "2001-01-01", "Album", &[], 3),
        ];
        assert_eq!(pick_release_group(&rs).unwrap().title, "rg3");
    }

    #[test]
    fn year_parsing() {
        assert_eq!(year(Some("1997-06-16")), Some(1997));
        assert_eq!(year(Some("1997")), Some(1997));
        assert_eq!(year(Some("")), None);
        assert_eq!(year(Some("19")), None);
        assert_eq!(year(None), None);
    }
}
