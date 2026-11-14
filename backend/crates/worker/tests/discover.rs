// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nimbus_core::events::{Event, EventBus, JobStage};
use nimbus_core::jobs::Job;
use nimbus_core::model::*;
use nimbus_db::repo::{acquisition, album_torrents, albums, artists, jobs, torrents, tracks};
use nimbus_trackers::*;
use nimbus_worker::discover::{discover_album, discover_artist, DiscoverHandler, EARLY_WAVE};
use nimbus_worker::{JobCtx, JobError, JobHandler};
use sqlx::PgPool;
use uuid::Uuid;

type SearchFn = dyn Fn(&SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> + Send + Sync;

struct Fake {
    source: TorrentSource,
    search: Box<SearchFn>,
    queries: Mutex<Vec<String>>,
    /// info-hash, который вернёт `resolve` для кандидатов без хеша.
    resolve_to: Option<&'static str>,
}

impl Fake {
    fn new(
        f: impl Fn(&SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            source: TorrentSource::Tpb,
            search: Box::new(f),
            queries: Mutex::new(vec![]),
            resolve_to: None,
        })
    }
}

#[async_trait]
impl TorrentProvider for Fake {
    fn source(&self) -> TorrentSource {
        self.source
    }
    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError> {
        self.queries.lock().unwrap().push(q.text.clone());
        (self.search)(q)
    }
    async fn resolve(&self, mut c: TorrentCandidate) -> Result<TorrentCandidate, ProviderError> {
        match (self.resolve_to, &c.info_hash) {
            (Some(h), None) => {
                c.info_hash = Some(InfoHash::parse(h).unwrap());
                Ok(c)
            }
            (None, None) => Err(ProviderError::Parse("cannot resolve".into())),
            _ => Ok(c),
        }
    }
}

fn hash(n: u8) -> InfoHash {
    InfoHash::parse(&format!("{:02x}", n).repeat(20)).unwrap()
}

fn cand(title: &str, h: Option<u8>, seeders: u32) -> TorrentCandidate {
    TorrentCandidate {
        source: TorrentSource::Tpb,
        source_topic_id: Some(format!("topic-{title}")),
        title: title.into(),
        info_hash: h.map(hash),
        magnet: h.map(|n| format!("magnet:?xt=urn:btih:{}", hash(n))),
        download_url: None,
        size_bytes: Some(400 * 1024 * 1024),
        seeders: Some(seeders),
        leechers: Some(1),
        category: None,
        files_count: None,
        torrent_file: None,
    }
}

fn ctx(pool: &PgPool, provider: Option<Arc<Fake>>, attempt: i32, max: i32) -> (JobCtx, EventBus) {
    let events = EventBus::new();
    let providers = match provider {
        Some(p) => vec![p as Arc<dyn TorrentProvider>],
        None => vec![],
    };
    let mut c = JobCtx::new(
        pool.clone(),
        events.clone(),
        nimbus_musicbrainz::MbClient::new("NimbusTest/0.1 ( https://example.org )", None).unwrap(),
        Arc::new(ProviderRegistry::new(providers)),
    );
    c.attempt = attempt;
    c.max_attempts = max;
    (c, events)
}

async fn artist(pool: &PgPool, name: &str) -> i64 {
    artists::upsert_by_mbid(
        pool,
        &NewArtist {
            mbid: Uuid::new_v4(),
            name: name.into(),
            sort_name: None,
            disambiguation: None,
        },
    )
    .await
    .unwrap()
    .id
}

/// Альбом с `n` треками; в библиотеку добавляется, если `in_library`.
async fn album(
    pool: &PgPool,
    artist_id: i64,
    title: &str,
    year: i32,
    n: i32,
    in_library: bool,
) -> i64 {
    let a = albums::upsert_by_rg_mbid(
        pool,
        &NewAlbum {
            mbid_release_group: Uuid::new_v4(),
            mbid_release: None,
            artist_id,
            title: title.into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            year: Some(year),
            cover_url: None,
        },
    )
    .await
    .unwrap();
    for i in 1..=n {
        tracks::upsert_by_mbid_track(
            pool,
            &NewTrack {
                mbid_recording: Uuid::new_v4(),
                mbid_track: None,
                album_id: a.id,
                artist_id,
                title: format!("Track {i}"),
                disc_no: 1,
                position: i,
                duration_ms: Some(180_000),
            },
        )
        .await
        .unwrap();
    }
    albums::set_in_library(pool, a.id, in_library)
        .await
        .unwrap();
    tracks::set_in_library_for_album(pool, a.id, in_library)
        .await
        .unwrap();
    a.id
}

async fn queued(pool: &PgPool, kind: &str) -> Vec<jobs::JobRow> {
    let mut v: Vec<_> = jobs::list(pool, Some("queued"), 100)
        .await
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == kind)
        .collect();
    v.sort_by_key(|j| j.id);
    v
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<Event>) -> Vec<Event> {
    let mut out = vec![];
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_creates_torrents_links_and_verify_jobs(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;

    let provider = Fake::new(|_q| {
        Ok(vec![
            cand("Radiohead - OK Computer (1997) [FLAC]", Some(1), 50),
            cand("Radiohead - OK Computer (1997) [MP3 320]", Some(2), 20),
            cand("Radiohead - Discography 1993-2016 [FLAC]", Some(3), 30),
            cand("Muse - OK Computer [FLAC]", Some(4), 50), // чужой артист
            cand("Radiohead - OK Computer [FLAC]", Some(5), 0), // 0 сидов: штраф, но не отбрасывается
            cand("Radiohead - Kid A [FLAC]", Some(6), 50),      // другой альбом
        ])
    });
    let (ctx, events) = ctx(&pool, Some(provider.clone()), 1, 5);
    let mut rx = events.subscribe();

    discover_album(&ctx, album_id).await.unwrap();

    // Три запроса (без «только артист»); одни и те же раздачи не дублируются.
    assert_eq!(provider.queries.lock().unwrap().len(), 3);
    let linked = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap();
    let titles: Vec<&str> = linked.iter().map(|t| t.torrent.title.as_str()).collect();
    assert_eq!(
        titles,
        [
            "Radiohead - OK Computer (1997) [FLAC]",
            "Radiohead - OK Computer (1997) [MP3 320]",
            "Radiohead - OK Computer [FLAC]",
            "Radiohead - Discography 1993-2016 [FLAC]",
        ]
    );
    assert_eq!(linked[0].torrent.kind, TorrentKind::Album);
    assert_eq!(linked[3].torrent.kind, TorrentKind::Discography);
    assert!(linked[0].rank_score > linked[1].rank_score);
    assert_eq!(linked[0].torrent.info_hash, hash(1).as_str());
    assert!(linked[0].torrent.magnet.starts_with("magnet:?"));
    assert_eq!(linked[0].torrent.seeders, Some(50));

    // verify-задачи на каждую раздачу, треки остаются в `adding`.
    let verify = queued(&pool, "verify_torrent").await;
    assert_eq!(verify.len(), 4);
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }

    let progress: Vec<(JobStage, u32, u32)> = drain(&mut rx)
        .into_iter()
        .filter_map(|e| match e {
            Event::JobProgress {
                album_id: a,
                stage,
                done,
                total,
            } if a == album_id => Some((stage, done, total)),
            _ => None,
        })
        .collect();
    assert_eq!(progress.first(), Some(&(JobStage::Searching, 0, 3)));
    assert_eq!(progress.last(), Some(&(JobStage::Searching, 3, 3)));

    // Повторный запуск идемпотентен.
    discover_album(&ctx, album_id).await.unwrap();
    assert_eq!(
        album_torrents::list_for_album(&pool, album_id)
            .await
            .unwrap()
            .len(),
        4
    );
    assert_eq!(queued(&pool, "verify_torrent").await.len(), 4);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_resolves_candidates_without_hash_and_skips_unresolvable(pool: PgPool) {
    let artist_id = artist(&pool, "Кино").await;
    let album_id = album(&pool, artist_id, "Группа крови", 1988, 2, true).await;

    let mut p = Fake::new(|_| {
        Ok(vec![
            cand("Кино - Группа крови (1988) [FLAC]", None, 10),
            cand("Кино - Группа крови (1988) [MP3 320]", Some(9), 10),
        ])
    });
    Arc::get_mut(&mut p).unwrap().resolve_to = Some("abababababababababababababababababababab");
    let (c, _) = ctx(&pool, Some(p), 1, 5);
    discover_album(&c, album_id).await.unwrap();
    let linked = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap();
    assert_eq!(linked.len(), 2);
    assert!(linked
        .iter()
        .any(|t| t.torrent.info_hash == "ab".repeat(20)));
    // Magnet построен из hash, если провайдер его не дал.
    let resolved = linked
        .iter()
        .find(|t| t.torrent.info_hash == "ab".repeat(20))
        .unwrap();
    assert!(resolved.torrent.magnet.contains("btih:abababab"));

    // Если resolve не удался — кандидат пропущен, остальные сохраняются.
    let album2 = album(&pool, artist_id, "Звезда по имени Солнце", 1989, 2, true).await;
    let p = Fake::new(|_| {
        Ok(vec![
            cand("Кино - Звезда по имени Солнце [FLAC]", None, 10),
            cand("Кино - Звезда по имени Солнце [MP3 320]", Some(8), 10),
        ])
    });
    let (c, _) = ctx(&pool, Some(p), 1, 5);
    discover_album(&c, album2).await.unwrap();
    assert_eq!(
        album_torrents::list_for_album(&pool, album2)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn zero_candidates_marks_tracks_not_found(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    let other = album(&pool, artist_id, "Kid A", 2000, 2, true).await;

    let provider = Fake::new(|_| Ok(vec![]));
    let (ctx, events) = ctx(&pool, Some(provider), 1, 5);
    let mut rx = events.subscribe();
    discover_album(&ctx, album_id).await.unwrap();

    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::NotFound);
        assert_eq!(t.status_reason.as_deref(), Some("no_torrents"));
    }
    // Чужой альбом не тронут.
    for t in tracks::list_by_album(&pool, other).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }
    let statuses = drain(&mut rx)
        .into_iter()
        .filter(|e| matches!(e, Event::TrackStatus { status: TrackStatus::NotFound, reason: Some(r), .. } if r == "no_torrents"))
        .count();
    assert_eq!(statuses, 3);
    assert!(queued(&pool, "verify_torrent").await.is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn irrelevant_candidates_count_as_no_torrents(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 1, true).await;
    let provider = Fake::new(|_| Ok(vec![cand("Muse - Absolution [FLAC]", Some(1), 99)]));
    let (ctx, _) = ctx(&pool, Some(provider), 1, 5);
    discover_album(&ctx, album_id).await.unwrap();
    let t = &tracks::list_by_album(&pool, album_id).await.unwrap()[0];
    assert_eq!(t.status, TrackStatus::NotFound);
    assert!(torrents::get(&pool, 1).await.unwrap().is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn provider_errors_retry_then_not_found_on_last_attempt(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let failing = || Fake::new(|_| Err(ProviderError::Blocked("down".into())));

    let (c, _) = ctx(&pool, Some(failing()), 1, 5);
    match discover_album(&c, album_id).await {
        Err(JobError::Retry { after, .. }) => assert_eq!(after.as_secs(), 600),
        other => panic!("expected Retry, got {other:?}"),
    }
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }

    let (c, _) = ctx(&pool, Some(failing()), 5, 5);
    discover_album(&c, album_id).await.unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(
            (t.status, t.status_reason.as_deref()),
            (TrackStatus::NotFound, Some("no_torrents"))
        );
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn nothing_to_search_does_not_touch_providers(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let not_in_lib = album(&pool, artist_id, "OK Computer", 1997, 2, false).await;
    let done = album(&pool, artist_id, "Kid A", 2000, 2, true).await;
    for t in tracks::list_by_album(&pool, done).await.unwrap() {
        tracks::set_status(&pool, t.id, TrackStatus::Ready, None)
            .await
            .unwrap();
    }
    let provider = Fake::new(|_| Ok(vec![]));
    let (c, _) = ctx(&pool, Some(provider.clone()), 1, 5);
    discover_album(&c, not_in_lib).await.unwrap();
    discover_album(&c, done).await.unwrap();
    assert!(provider.queries.lock().unwrap().is_empty());
    assert!(matches!(
        discover_album(&c, 9999).await,
        Err(JobError::Fatal(_))
    ));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn artist_links_discography_to_all_library_albums(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let a1 = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let a2 = album(&pool, artist_id, "Kid A", 2000, 2, true).await;
    let outside = album(&pool, artist_id, "Pablo Honey", 1993, 2, false).await;

    let provider = Fake::new(|_| {
        Ok(vec![
            cand("Radiohead - Discography 1993-2016 (MP3 320)", Some(1), 40),
            cand("Radiohead - OK Computer (1997) [FLAC]", Some(2), 60), // не дискография
            cand("Karaoke - Radiohead hits", Some(3), 60),
            cand("Muse - Discography 1999-2015", Some(4), 60),
        ])
    });
    let (c, _) = ctx(&pool, Some(provider.clone()), 1, 5);
    discover_artist(&c, artist_id).await.unwrap();

    assert_eq!(
        *provider.queries.lock().unwrap(),
        [
            "Radiohead discography",
            "Radiohead дискография",
            "Radiohead"
        ]
    );
    for album_id in [a1, a2] {
        let linked = album_torrents::list_for_album(&pool, album_id)
            .await
            .unwrap();
        assert_eq!(linked.len(), 1, "album {album_id}");
        assert_eq!(linked[0].torrent.kind, TorrentKind::Discography);
        assert_eq!(
            linked[0].torrent.title,
            "Radiohead - Discography 1993-2016 (MP3 320)"
        );
    }
    assert!(album_torrents::list_for_album(&pool, outside)
        .await
        .unwrap()
        .is_empty());

    // DiscoverAlbum больше не ставится: альбомы ищутся по мере импорта.
    assert!(queued(&pool, "discover_album").await.is_empty());
    // Для каждой пары (дискография, альбом библиотеки) — своя проверка, без отсрочек.
    let verifies = queued(&pool, "verify_torrent").await;
    let mut albums_verified: Vec<i64> = verifies
        .iter()
        .map(|j| j.payload["album_id"].as_i64().unwrap())
        .collect();
    albums_verified.sort_unstable();
    assert_eq!(albums_verified, [a1, a2]);
    assert!(verifies
        .iter()
        .all(|j| j.run_after <= chrono::Utc::now() && j.priority == 1));
}

fn discography_provider() -> Arc<Fake> {
    Fake::new(|_| {
        Ok(vec![cand(
            "Radiohead - Discography 1993-2016 (MP3 320)",
            Some(1),
            40,
        )])
    })
}

/// Порядок «альбом уже есть → дискография найдена» проверен выше; здесь обратный:
/// дискография найдена раньше, чем альбом попал в библиотеку.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_imported_after_artist_discovery_gets_discography_and_verify(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let (c, _) = ctx(&pool, Some(discography_provider()), 1, 5);
    // В библиотеке альбомов ещё нет: дискография всё равно находится и запоминается.
    discover_artist(&c, artist_id).await.unwrap();
    assert!(queued(&pool, "verify_torrent").await.is_empty());

    let late = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let (c2, _) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    discover_album(&c2, late).await.unwrap();

    let linked = album_torrents::list_for_album(&pool, late).await.unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].torrent.kind, TorrentKind::Discography);
    let verifies = queued(&pool, "verify_torrent").await;
    assert_eq!(verifies.len(), 1);
    assert_eq!(verifies[0].payload["album_id"], late);
    assert_eq!(verifies[0].payload["torrent_id"], linked[0].torrent.id);
    // Поиск ничего не нашёл сам, но дискография есть — альбом не объявляется ненайденным.
    for t in tracks::list_by_album(&pool, late).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn discover_artist_skips_artists_outside_the_library(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let provider = discography_provider();
    let (c, _) = ctx(&pool, Some(provider.clone()), 1, 5);
    discover_artist(&c, artist_id).await.unwrap();
    assert!(provider.queries.lock().unwrap().is_empty());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_does_not_reverify_already_verified_discography(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let (c, _) = ctx(&pool, Some(discography_provider()), 1, 5);
    discover_artist(&c, artist_id).await.unwrap();
    let t = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap()[0]
        .torrent
        .id;
    album_torrents::mark_verified(&pool, album_id, t)
        .await
        .unwrap();
    sqlx::query("DELETE FROM jobs WHERE kind = 'verify_torrent'")
        .execute(&pool)
        .await
        .unwrap();

    let (c2, _) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    discover_album(&c2, album_id).await.unwrap();
    assert!(queued(&pool, "verify_torrent").await.is_empty());
}

/// Первые `EARLY_WAVE` раздач проверяются с приоритетом выше остальных, без отсрочек.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn verify_priority_first_wave_is_higher(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let provider = Fake::new(|_| {
        Ok((1..=5u8)
            .map(|n| {
                cand(
                    &format!("Radiohead - OK Computer (1997) [FLAC] {n}"),
                    Some(n),
                    10 + u32::from(n),
                )
            })
            .collect())
    });
    let (c, _) = ctx(&pool, Some(provider), 1, 5);
    discover_album(&c, album_id).await.unwrap();

    let rows = queued(&pool, "verify_torrent").await;
    assert_eq!(rows.len(), 5);
    let high = rows.iter().filter(|j| j.priority == c.priority + 1).count();
    let normal = rows.iter().filter(|j| j.priority == c.priority).count();
    assert_eq!((high, normal), (EARLY_WAVE, 5 - EARLY_WAVE));
    assert!(rows.iter().all(|j| j.run_after <= chrono::Utc::now()));
}

/// Когда все треки уже найдены, остальные раздачи — резерв с фоновым приоритетом.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn backup_verifies_are_background_when_all_tracks_found(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    sqlx::query("UPDATE tracks SET status = 'found' WHERE album_id = $1")
        .bind(album_id)
        .execute(&pool)
        .await
        .unwrap();
    let (c, _) = ctx(&pool, Some(discography_provider()), 1, 5);
    discover_artist(&c, artist_id).await.unwrap();
    let rows = queued(&pool, "verify_torrent").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].priority, nimbus_core::jobs::PRIORITY_BACKGROUND);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_uses_prelinked_discography_even_without_new_candidates(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let t = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: hash(7),
            magnet: "magnet:?xt=urn:btih:x".into(),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "Radiohead - Discography".into(),
            size_bytes: None,
            seeders: Some(10),
            leechers: None,
            kind: TorrentKind::Discography,
        },
    )
    .await
    .unwrap();
    album_torrents::link(&pool, album_id, t.id, "q", 0.4)
        .await
        .unwrap();

    let (c, _) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    discover_album(&c, album_id).await.unwrap();
    for tr in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(tr.status, TrackStatus::Adding);
    }
    let verify = queued(&pool, "verify_torrent").await;
    assert_eq!(verify.len(), 1);
    assert_eq!(verify[0].payload["torrent_id"], t.id);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn handler_dispatches_jobs(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 1, true).await;
    let provider = Fake::new(|_| Ok(vec![cand("Radiohead - OK Computer [FLAC]", Some(1), 5)]));
    let (c, _) = ctx(&pool, Some(provider), 1, 5);
    DiscoverHandler
        .handle(Job::DiscoverAlbum { album_id }, &c)
        .await
        .unwrap();
    assert_eq!(queued(&pool, "verify_torrent").await.len(), 1);
    DiscoverHandler
        .handle(Job::DiscoverArtist { artist_id }, &c)
        .await
        .unwrap();
    assert!(DiscoverHandler
        .handle(Job::ImportArtist { artist_id }, &c)
        .await
        .is_err());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_discover_without_torrents_marks_search_failed(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    // Провайдер падает всегда: до последней попытки — Retry.
    let provider = Fake::new(|_| Err(ProviderError::Network("down".into())));
    let (ctx, events) = ctx(&pool, Some(provider), 1, 2);
    let mut rx = events.subscribe();
    let err = discover_album(&ctx, album_id).await.unwrap_err();
    assert!(matches!(err, JobError::Retry { .. }), "{err:?}");

    DiscoverHandler
        .on_exhausted(&Job::DiscoverAlbum { album_id }, &ctx, "providers down")
        .await
        .unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::NotFound);
        assert_eq!(t.status_reason.as_deref(), Some("search_failed"));
    }
    let events = drain(&mut rx)
        .into_iter()
        .filter(|e| matches!(e, Event::TrackStatus { status: TrackStatus::NotFound, reason: Some(r), .. } if r == "search_failed"))
        .count();
    assert_eq!(events, 3);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_discover_with_linked_torrent_finalizes_instead(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    // Раздача прилинкована и уже проверена (ничего не нашла), но discover упал: альбом не должен зависнуть.
    let t = torrents::upsert_by_info_hash(
        &pool,
        &NewTorrent {
            info_hash: hash(1),
            magnet: format!("magnet:?xt=urn:btih:{}", hash(1)),
            source: TorrentSource::Tpb,
            source_topic_id: None,
            title: "t".into(),
            size_bytes: None,
            seeders: None,
            leechers: None,
            kind: TorrentKind::Album,
        },
    )
    .await
    .unwrap();
    album_torrents::link(&pool, album_id, t.id, "q", 0.5)
        .await
        .unwrap();
    album_torrents::mark_verified(&pool, album_id, t.id)
        .await
        .unwrap();
    let (ctx, _) = ctx(&pool, None, 5, 5);
    DiscoverHandler
        .on_exhausted(&Job::DiscoverAlbum { album_id }, &ctx, "boom")
        .await
        .unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::NotFound);
        assert_ne!(t.status_reason.as_deref(), Some("search_failed"));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn discover_stops_with_cancelled_when_pool_is_shutting_down(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    let provider = Fake::new(|_| Ok(vec![]));
    let (ctx, _) = ctx(&pool, Some(provider), 1, 5);
    ctx.cancel.cancel();
    let err = discover_album(&ctx, album_id).await.unwrap_err();
    assert!(matches!(err, JobError::Cancelled), "{err:?}");
    // Состояние не испорчено: треки всё ещё ждут поиска.
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }
}

fn candidate_with_file(title: &str, bytes: Vec<u8>) -> TorrentCandidate {
    let h = nimbus_torrent::parse_torrent_file(&bytes, None)
        .unwrap()
        .info_hash;
    TorrentCandidate {
        info_hash: Some(h.clone()),
        magnet: Some(format!("magnet:?xt=urn:btih:{h}")),
        torrent_file: Some(bytes),
        ..cand(title, None, 50)
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn candidate_torrent_file_fills_files_before_verify(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    let bytes = nimbus_testkit::torrent_file(
        "Radiohead - OK Computer (1997) [FLAC]",
        &[("01 - Airbag.flac", 1000), ("02 - Exit Music.flac", 2000)],
    );
    let wanted = bytes.clone();
    let provider = Fake::new(move |_q| {
        Ok(vec![candidate_with_file(
            "Radiohead - OK Computer (1997) [FLAC]",
            wanted.clone(),
        )])
    });
    let (ctx, _) = ctx(&pool, Some(provider), 1, 5);

    discover_album(&ctx, album_id).await.unwrap();

    let linked = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap();
    assert_eq!(linked.len(), 1);
    let t = &linked[0].torrent;
    // Метаданные известны ещё до verify: файл сохранён, список файлов и статус заполнены.
    assert!(t.has_torrent_file);
    assert_eq!(t.meta_status, MetaStatus::Ok);
    assert_eq!(
        torrents::torrent_file(&pool, t.id).await.unwrap(),
        Some(bytes)
    );
    let files = torrents::files(&pool, t.id).await.unwrap();
    let got: Vec<(&str, i64)> = files
        .iter()
        .map(|f| (f.path.as_str(), f.size_bytes))
        .collect();
    assert_eq!(
        got,
        [("01 - Airbag.flac", 1000), ("02 - Exit Music.flac", 2000)]
    );
    assert_eq!(files[0].ext.as_deref(), Some("flac"));
    assert_eq!(queued(&pool, "verify_torrent").await.len(), 1);

    // Повторный поиск идемпотентен: файл и список остаются.
    discover_album(&ctx, album_id).await.unwrap();
    assert_eq!(torrents::files(&pool, t.id).await.unwrap().len(), 2);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn candidate_torrent_file_with_foreign_hash_is_ignored(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 3, true).await;
    let bytes = nimbus_testkit::torrent_file("x", &[("01.flac", 10)]);
    let provider = Fake::new(move |_q| {
        let mut c = cand("Radiohead - OK Computer (1997) [FLAC]", Some(1), 50);
        c.torrent_file = Some(bytes.clone()); // хеш байтов ≠ хеша кандидата
        Ok(vec![c])
    });
    let (ctx, _) = ctx(&pool, Some(provider), 1, 5);

    discover_album(&ctx, album_id).await.unwrap();

    let linked = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap();
    assert_eq!(linked.len(), 1, "раздача всё равно сохранена");
    let t = &linked[0].torrent;
    assert!(!t.has_torrent_file);
    assert_ne!(t.meta_status, MetaStatus::Ok);
    assert!(torrents::files(&pool, t.id).await.unwrap().is_empty());
}

/// Альбом ничего не нашёл сам, а поиск дискографий артиста ещё идёт: решение откладывается
/// до его завершения (иначе статус «не найден» мигнул бы, а потом стал «найден»).
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn album_without_candidates_waits_for_active_discover_artist(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    jobs::enqueue(
        &pool,
        &Job::DiscoverArtist { artist_id },
        nimbus_db::repo::jobs::EnqueueOpts::default(),
    )
    .await
    .unwrap();

    let (c, _) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    discover_album(&c, album_id).await.unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::Adding);
    }

    // Поиск артиста завершается пустым: альбом получает `no_torrents`.
    sqlx::query("UPDATE jobs SET state = 'running' WHERE kind = 'discover_artist'")
        .execute(&pool)
        .await
        .unwrap();
    discover_artist(&c, artist_id).await.unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(
            (t.status, t.status_reason.as_deref()),
            (TrackStatus::NotFound, Some("no_torrents"))
        );
    }
}

/// Исчерпанный `discover_artist` не оставляет альбомы в вечном `adding`.
#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_discover_artist_finalizes_its_albums(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    artists::set_in_library(&pool, artist_id, true)
        .await
        .unwrap();
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let (c, _) = ctx(&pool, None, 5, 5);
    DiscoverHandler
        .on_exhausted(&Job::DiscoverArtist { artist_id }, &c, "boom")
        .await
        .unwrap();
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status, TrackStatus::NotFound);
    }
}

// ------------------------------------------------------------------ состояние поиска (шаг 32)

fn opts(reset_dead: bool) -> nimbus_library::retry::RetryOptions {
    nimbus_library::retry::RetryOptions {
        priority: nimbus_core::jobs::PRIORITY_INTERACTIVE,
        reset_dead,
        manual: true,
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn search_without_candidates_is_recorded_with_first_backoff(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let (c, events) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    let mut rx = events.subscribe();
    discover_album(&c, album_id).await.unwrap();

    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.attempts, 1);
    assert_eq!(s.last_outcome, Some(SearchOutcome::NoTorrents));
    assert_eq!(s.candidates, 0);
    assert_eq!(s.provider_errors, serde_json::json!([]));
    assert!(s.last_started_at.unwrap() <= s.last_finished_at.unwrap());
    let wait = s.next_retry_at.unwrap() - s.last_finished_at.unwrap();
    assert_eq!(wait.num_hours(), 6);
    assert!(drain(&mut rx)
        .iter()
        .any(|e| matches!(e, Event::AcquisitionChanged { album_id: a } if *a == album_id)));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn backoff_follows_auto_retries_in_the_worker(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 1, true).await;
    let (c, _) = ctx(&pool, Some(Fake::new(|_| Ok(vec![]))), 1, 5);
    for (auto, hours) in [(0, 6), (1, 24), (2, 72), (3, 168), (4, 720)] {
        sqlx::query(
            "UPDATE tracks SET status = 'adding', status_reason = NULL WHERE album_id = $1",
        )
        .bind(album_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO album_search_state (album_id, auto_retries) VALUES ($1, $2)
             ON CONFLICT (album_id) DO UPDATE SET auto_retries = $2",
        )
        .bind(album_id)
        .bind(auto)
        .execute(&pool)
        .await
        .unwrap();
        discover_album(&c, album_id).await.unwrap();
        let s = acquisition::get_state(&pool, album_id)
            .await
            .unwrap()
            .unwrap();
        let wait = s.next_retry_at.unwrap() - s.last_finished_at.unwrap();
        assert_eq!(wait.num_hours(), hours, "auto_retries = {auto}");
    }
    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.attempts, 5);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn provider_errors_are_stored_with_source_and_text(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let failing = || Fake::new(|_| Err(ProviderError::Blocked("cloudflare".into())));

    // Первая попытка: повтор позже; поиск начат, но не закончен — итога ещё нет.
    let (c, _) = ctx(&pool, Some(failing()), 1, 5);
    assert!(matches!(
        discover_album(&c, album_id).await,
        Err(JobError::Retry { .. })
    ));
    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.attempts, s.last_outcome), (0, None));
    assert!(s.last_started_at.is_some() && s.last_finished_at.is_none());
    let errors = s.provider_errors.as_array().unwrap();
    assert_eq!(errors.len(), 1, "три запроса с одной ошибкой — одна запись");
    assert_eq!(errors[0]["source"], "tpb");
    assert!(errors[0]["error"].as_str().unwrap().contains("cloudflare"));

    // Последняя попытка: поиск закончен, ошибки остались в состоянии.
    let (c, _) = ctx(&pool, Some(failing()), 5, 5);
    discover_album(&c, album_id).await.unwrap();
    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (s.attempts, s.last_outcome),
        (1, Some(SearchOutcome::NoTorrents))
    );
    assert_eq!(s.provider_errors.as_array().unwrap().len(), 1);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn exhausted_search_finishes_as_search_failed(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let (c, _) = ctx(
        &pool,
        Some(Fake::new(|_| Err(ProviderError::Blocked("down".into())))),
        1,
        5,
    );
    assert!(discover_album(&c, album_id).await.is_err());
    DiscoverHandler
        .on_exhausted(&Job::DiscoverAlbum { album_id }, &c, "attempts exhausted")
        .await
        .unwrap();

    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (s.attempts, s.last_outcome),
        (1, Some(SearchOutcome::SearchFailed))
    );
    assert!(s.next_retry_at.is_some());
    for t in tracks::list_by_album(&pool, album_id).await.unwrap() {
        assert_eq!(t.status_reason.as_deref(), Some("search_failed"));
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn candidates_are_counted_and_finish_waits_for_verification(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let provider = Fake::new(|_| {
        Ok(vec![
            cand("Radiohead - OK Computer (1997) [FLAC]", Some(1), 50),
            cand("Radiohead - OK Computer (1997) [MP3 320]", Some(2), 20),
        ])
    });
    let (c, _) = ctx(&pool, Some(provider), 1, 5);
    discover_album(&c, album_id).await.unwrap();
    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s.candidates, 2);
    assert_eq!(
        s.attempts, 0,
        "раздачи ещё не проверены — поиск не закончен"
    );
    assert!(s.last_started_at.is_some() && s.last_finished_at.is_none());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn repeat_search_skips_verified_torrents_unless_reset_dead(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, true).await;
    let provider = Fake::new(|_| {
        Ok(vec![cand(
            "Radiohead - OK Computer (1997) [FLAC]",
            Some(1),
            50,
        )])
    });
    let (c, events) = ctx(&pool, Some(provider), 1, 5);

    // Первый поиск: раздача привязана, verify поставлен.
    discover_album(&c, album_id).await.unwrap();
    assert_eq!(queued(&pool, "verify_torrent").await.len(), 1);
    let torrent_id = album_torrents::list_for_album(&pool, album_id)
        .await
        .unwrap()[0]
        .torrent
        .id;

    // «Проверили»: раздача отмечена, треки не нашлись.
    let settle = |dead: bool| {
        let pool = pool.clone();
        async move {
            album_torrents::mark_verified(&pool, album_id, torrent_id)
                .await
                .unwrap();
            if dead {
                torrents::set_meta_status(&pool, torrent_id, MetaStatus::Dead, Some("timeout"))
                    .await
                    .unwrap();
            }
            tracks::set_status_for_album(
                &pool,
                album_id,
                &[TrackStatus::Adding],
                TrackStatus::NotFound,
                Some(NotFoundReason::NoMatch),
            )
            .await
            .unwrap();
            sqlx::query("DELETE FROM jobs")
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    settle(false).await;

    // Обычный повтор: те же кандидаты уже проверены — verify не ставится.
    let report = nimbus_library::retry::retry_album(&pool, &events, album_id, opts(false))
        .await
        .unwrap();
    assert_eq!((report.queued, report.tracks_reset), (true, 2));
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    discover_album(&c, album_id).await.unwrap();
    assert!(queued(&pool, "verify_torrent").await.is_empty());

    // Раздача признана мёртвой; `reset_dead` отдаёт её на повторную проверку.
    settle(true).await;
    nimbus_library::retry::retry_album(&pool, &events, album_id, opts(true))
        .await
        .unwrap();
    sqlx::query("DELETE FROM jobs")
        .execute(&pool)
        .await
        .unwrap();
    discover_album(&c, album_id).await.unwrap();
    assert_eq!(queued(&pool, "verify_torrent").await.len(), 1);
    let t = torrents::get(&pool, torrent_id).await.unwrap().unwrap();
    assert_eq!((t.meta_status, t.meta_attempts), (MetaStatus::Pending, 0));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn manual_retry_resets_auto_retries_and_raises_priority(pool: PgPool) {
    let artist_id = artist(&pool, "Radiohead").await;
    let album_id = album(&pool, artist_id, "OK Computer", 1997, 2, false).await;
    tracks::set_in_library_for_album(&pool, album_id, true)
        .await
        .unwrap();
    tracks::set_status_for_album(
        &pool,
        album_id,
        &[TrackStatus::Adding],
        TrackStatus::NotFound,
        Some(NotFoundReason::NoMatch),
    )
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO album_search_state (album_id, auto_retries, next_retry_at) VALUES ($1, 3, now() + interval '7 days')",
    )
    .bind(album_id)
    .execute(&pool)
    .await
    .unwrap();
    // Авто-повтор уже ждёт в очереди с фоновым приоритетом.
    jobs::enqueue(
        &pool,
        &Job::DiscoverAlbum { album_id },
        nimbus_db::repo::jobs::EnqueueOpts::priority(nimbus_core::jobs::PRIORITY_BACKGROUND),
    )
    .await
    .unwrap();

    let events = EventBus::new();
    let report = nimbus_library::retry::retry_album(&pool, &events, album_id, opts(false))
        .await
        .unwrap();
    assert!(!report.queued, "задача уже была, дубликат не ставится");
    let job = &queued(&pool, "discover_album").await[0];
    assert_eq!(job.priority, nimbus_core::jobs::PRIORITY_INTERACTIVE);
    let s = acquisition::get_state(&pool, album_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((s.auto_retries, s.next_retry_at), (0, None));
}
