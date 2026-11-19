//! `GET /api/search` — поиск в MusicBrainz с пометкой «уже в библиотеке».

use std::collections::{HashMap, HashSet};
use std::future::Future;

use axum::extract::{Query, State};
use axum::Json;
use nimbus_core::model::TrackStatus;
use nimbus_db::repo::{albums, artists, tracks};
use nimbus_musicbrainz::{cover_url, MbError};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: u8 = 8;
const MAX_LIMIT: u8 = 25;
const MAX_QUERY_CHARS: usize = 200;
/// Короче — ищем только артистов (экономия лимита MB).
const MIN_FULL_SEARCH_CHARS: usize = 3;
const COVER_SIZE: u16 = 250;
/// Сколько кандидатов брать у MB для переранжирования по популярности (максимум MB).
const CANDIDATES: u8 = 100;
/// С какого score MB лучший артист считается уверенным совпадением и приносит свою дискографию.
const TOP_ARTIST_SCORE: u8 = 90;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchParams {
    /// Строка поиска, 1..200 символов.
    q: Option<String>,
    /// Через запятую: `artist,album,track` (по умолчанию все).
    types: Option<String>,
    /// 1..25, по умолчанию 8.
    limit: Option<u8>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SearchResponse {
    pub query: String,
    pub artists: Vec<ArtistResult>,
    pub albums: Vec<AlbumResult>,
    pub tracks: Vec<TrackResult>,
    /// Если часть запросов к MusicBrainz не удалась — остальное всё равно отдаётся.
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArtistResult {
    pub mbid: Uuid,
    pub name: String,
    pub disambiguation: Option<String>,
    pub country: Option<String>,
    pub score: u8,
    /// `id` в нашей БД, если артист добавлен в библиотеку.
    pub library_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AlbumResult {
    pub mbid: Uuid,
    pub title: String,
    pub artist_mbid: Uuid,
    pub artist_name: String,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub year: Option<i32>,
    pub cover_url: String,
    pub score: u8,
    pub library_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TrackResult {
    pub mbid: Uuid,
    pub title: String,
    pub artist_mbid: Uuid,
    pub artist_name: String,
    pub album_mbid: Option<Uuid>,
    pub album_title: Option<String>,
    pub duration_ms: Option<u32>,
    pub cover_url: Option<String>,
    pub score: u8,
    pub library_id: Option<i64>,
    /// Id альбома трека в библиотеке (для перехода к альбому).
    pub album_library_id: Option<i64>,
    pub status: Option<TrackStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Artist,
    Album,
    Track,
}

fn parse_types(raw: Option<&str>) -> Result<HashSet<Kind>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok([Kind::Artist, Kind::Album, Kind::Track].into());
    };
    raw.split(',')
        .map(|t| match t.trim() {
            "artist" => Ok(Kind::Artist),
            "album" => Ok(Kind::Album),
            "track" => Ok(Kind::Track),
            other => Err(ApiError::bad_request(
                "bad_types",
                format!("unknown type {other:?}, expected artist, album or track"),
            )),
        })
        .collect()
}

/// Выполняет запрос к MB, если тип запрошен; ошибка/таймаут превращается в строку для `errors`.
async fn run<T, F>(
    enabled: bool,
    name: &str,
    deadline: Instant,
    fut: F,
    errors: &mut Vec<String>,
) -> Vec<T>
where
    F: Future<Output = Result<Vec<T>, MbError>>,
{
    if !enabled {
        return Vec::new();
    }
    match tokio::time::timeout_at(deadline, fut).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(kind = name, error = %e, "search request failed");
            errors.push(format!("{name}: {e}"));
            Vec::new()
        }
        Err(_) => {
            errors.push(format!("{name}: timeout"));
            Vec::new()
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/search",
    tag = "search",
    params(SearchParams),
    responses(
        (status = 200, description = "Результаты поиска", body = SearchResponse),
        (status = 400, description = "Некорректный запрос (bad_query, bad_types, bad_limit)", body = crate::error::ErrorResponse),
    )
)]
pub async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<SearchResponse>, ApiError> {
    let q = params.q.as_deref().unwrap_or("").trim().to_string();
    let q_len = q.chars().count();
    if q_len == 0 || q_len > MAX_QUERY_CHARS {
        return Err(ApiError::bad_request(
            "bad_query",
            format!("q must be 1..{MAX_QUERY_CHARS} characters"),
        ));
    }
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::bad_request(
            "bad_limit",
            format!("limit must be 1..{MAX_LIMIT}"),
        ));
    }
    let mut kinds = parse_types(params.types.as_deref())?;
    if q_len < MIN_FULL_SEARCH_CHARS {
        kinds = [Kind::Artist].into();
    }

    let deadline = Instant::now() + state.search_timeout;
    let mb = &state.mb;
    let (mut e_artists, mut e_albums, mut e_tracks) = (Vec::new(), Vec::new(), Vec::new());
    let (artist_hits, album_hits, track_hits) = tokio::join!(
        run(
            kinds.contains(&Kind::Artist),
            "artists",
            deadline,
            mb.search_artists(&q, limit),
            &mut e_artists
        ),
        run(
            kinds.contains(&Kind::Album),
            "albums",
            deadline,
            mb.search_release_groups(&q, CANDIDATES),
            &mut e_albums
        ),
        run(
            kinds.contains(&Kind::Track),
            "tracks",
            deadline,
            mb.search_recordings(&q, CANDIDATES),
            &mut e_tracks
        ),
    );
    let mut e_discography = Vec::new();
    let mut album_hits = album_hits;
    // Текстовый поиск альбомов не знает алиасов артиста («Монатик» → MONATIK): дополняем выдачу дискографией
    // лучшего артиста по MBID, как это делает экран артиста.
    if let Some(top) = artist_hits.first().filter(|a| a.score >= TOP_ARTIST_SCORE) {
        let groups = run(
            kinds.contains(&Kind::Album),
            "albums",
            deadline,
            mb.artist_release_groups(top.mbid, crate::catalog::DISCOGRAPHY_TYPES),
            &mut e_discography,
        )
        .await;
        merge_discography(&mut album_hits, groups, top.mbid, top.score);
    }
    let mut errors = [e_artists, e_albums, e_tracks, e_discography].concat();
    // Обрыв «albums» мог случиться и в текстовом поиске, и в дискографии — сообщаем один раз.
    let mut seen = HashSet::new();
    errors.retain(|e| seen.insert(e.clone()));

    // MB отдаёт десятки записей с одинаковым score 100 (каверы, лайвы) — при равном score
    // выше ставим то, что чаще слушают (ListenBrainz), и только потом обрезаем до limit.
    let album_ids: Vec<Uuid> = album_hits.iter().map(|a| a.mbid).collect();
    let track_ids: Vec<Uuid> = track_hits.iter().map(|t| t.mbid).collect();
    let (album_pop, track_pop) = tokio::join!(
        mb.release_group_popularity(&album_ids),
        mb.recording_popularity(&track_ids),
    );
    let (mut album_hits, mut track_hits) = (album_hits, track_hits);
    rank_by_popularity(&mut album_hits, &album_pop, |a| (a.mbid, a.score), limit);
    rank_by_popularity(&mut track_hits, &track_pop, |t| (t.mbid, t.score), limit);

    // Обогащение: по одному запросу на тип. Сбой БД не должен ломать поиск.
    let artist_ids = lookup(
        "artists",
        artist_hits.is_empty(),
        artists::library_ids_by_mbid(
            &state.db,
            &artist_hits.iter().map(|a| a.mbid).collect::<Vec<_>>(),
        ),
        &mut errors,
    )
    .await;
    let album_ids = lookup(
        "albums",
        album_hits.is_empty(),
        albums::library_ids_by_rg_mbid(
            &state.db,
            &album_hits.iter().map(|a| a.mbid).collect::<Vec<_>>(),
        ),
        &mut errors,
    )
    .await;
    let track_info: HashMap<Uuid, (i64, TrackStatus, i64)> = lookup(
        "tracks",
        track_hits.is_empty(),
        tracks::library_info_by_recording(
            &state.db,
            &track_hits.iter().map(|t| t.mbid).collect::<Vec<_>>(),
        ),
        &mut errors,
    )
    .await
    .into_iter()
    .map(|(mbid, id, status, album_id)| (mbid, (id, status, album_id)))
    .collect();
    let artist_ids: HashMap<_, _> = artist_ids.into_iter().collect();
    let album_ids: HashMap<_, _> = album_ids.into_iter().collect();

    Ok(Json(SearchResponse {
        query: q,
        artists: artist_hits
            .into_iter()
            .map(|a| ArtistResult {
                library_id: artist_ids.get(&a.mbid).copied(),
                mbid: a.mbid,
                name: a.name,
                disambiguation: a.disambiguation,
                country: a.country,
                score: a.score,
            })
            .collect(),
        albums: album_hits
            .into_iter()
            .map(|a| AlbumResult {
                library_id: album_ids.get(&a.mbid).copied(),
                cover_url: cover_url(a.mbid, COVER_SIZE),
                mbid: a.mbid,
                title: a.title,
                artist_mbid: a.artist_mbid,
                artist_name: a.artist_name,
                primary_type: a.primary_type,
                secondary_types: a.secondary_types,
                year: a.year,
                score: a.score,
            })
            .collect(),
        tracks: track_hits
            .into_iter()
            .map(|t| {
                let info = track_info.get(&t.mbid);
                TrackResult {
                    library_id: info.map(|i| i.0),
                    album_library_id: info.map(|i| i.2),
                    status: info.map(|i| i.1),
                    cover_url: t.release_group_mbid.map(|id| cover_url(id, COVER_SIZE)),
                    mbid: t.mbid,
                    title: t.title,
                    artist_mbid: t.artist_mbid,
                    artist_name: t.artist_name,
                    album_mbid: t.release_group_mbid,
                    album_title: t.album_title,
                    duration_ms: t.duration_ms,
                    score: t.score,
                }
            })
            .collect(),
        errors,
    }))
}

/// Добавляет к найденным альбомам собственную дискографию артиста (без совместных и без повторов); ей
/// ставится score артиста, чтобы дальше она ранжировалась по популярности наравне с текстовыми совпадениями.
fn merge_discography(
    hits: &mut Vec<nimbus_musicbrainz::ReleaseGroupHit>,
    groups: Vec<nimbus_musicbrainz::ReleaseGroupHit>,
    artist: Uuid,
    score: u8,
) {
    let mut seen: HashSet<Uuid> = hits.iter().map(|h| h.mbid).collect();
    for mut g in groups {
        if g.artist_mbid == artist && seen.insert(g.mbid) {
            g.score = score;
            hits.push(g);
        }
    }
}

/// Стабильная сортировка: score MB ↓, затем прослушивания ↓; обрезка до `limit`.
fn rank_by_popularity<T>(
    hits: &mut Vec<T>,
    pop: &HashMap<Uuid, u64>,
    key: impl Fn(&T) -> (Uuid, u8),
    limit: u8,
) {
    hits.sort_by_key(|h| {
        let (id, score) = key(h);
        std::cmp::Reverse((score, pop.get(&id).copied().unwrap_or(0)))
    });
    hits.truncate(limit as usize);
}

async fn lookup<T>(
    name: &str,
    skip: bool,
    fut: impl Future<Output = sqlx::Result<Vec<T>>>,
    errors: &mut Vec<String>,
) -> Vec<T> {
    if skip {
        return Vec::new();
    }
    match fut.await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, kind = name, "library lookup failed");
            errors.push(format!("{name}: library lookup failed"));
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_parsing() {
        assert_eq!(parse_types(None).unwrap().len(), 3);
        assert_eq!(parse_types(Some("")).unwrap().len(), 3);
        let t = parse_types(Some("artist, track")).unwrap();
        assert!(t.contains(&Kind::Artist) && t.contains(&Kind::Track) && !t.contains(&Kind::Album));
        assert!(parse_types(Some("artist,bogus")).is_err());
    }

    #[test]
    fn popularity_breaks_score_ties_then_truncates() {
        let ids: Vec<Uuid> = (1..=4).map(Uuid::from_u128).collect();
        // (id, score): все 100, кроме последнего; популярнее всех — ids[2].
        let mut hits = vec![(ids[0], 100u8), (ids[1], 100), (ids[2], 100), (ids[3], 90)];
        let pop = HashMap::from([(ids[2], 9000), (ids[1], 10), (ids[3], 99999)]);
        rank_by_popularity(&mut hits, &pop, |h| *h, 3);
        assert_eq!(
            hits.iter().map(|h| h.0).collect::<Vec<_>>(),
            vec![ids[2], ids[1], ids[0]]
        );
    }
}

#[cfg(test)]
mod discography_tests {
    use super::*;
    use nimbus_musicbrainz::ReleaseGroupHit;

    fn rg(id: u128, artist: u128, score: u8) -> ReleaseGroupHit {
        ReleaseGroupHit {
            mbid: Uuid::from_u128(id),
            title: format!("rg{id}"),
            artist_mbid: Uuid::from_u128(artist),
            artist_name: "A".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(2020),
            score,
        }
    }

    #[test]
    fn merge_adds_missing_own_albums_without_duplicates_or_collabs() {
        // Текстовый поиск нашёл один альбом артиста 1; дискография — три своих, один повтор и один чужой.
        let mut hits = vec![rg(10, 1, 100)];
        let groups = vec![rg(10, 1, 0), rg(11, 1, 0), rg(12, 1, 0), rg(13, 2, 0)];
        merge_discography(&mut hits, groups, Uuid::from_u128(1), 95);
        let ids: Vec<u128> = hits.iter().map(|h| h.mbid.as_u128()).collect();
        assert_eq!(ids, vec![10, 11, 12]);
        assert_eq!(hits[0].score, 100, "найденный текстом не перезаписывается");
        assert_eq!(hits[1].score, 95);
    }
}
