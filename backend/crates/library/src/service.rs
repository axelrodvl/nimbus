use nimbus_core::events::{Entity, Event, EventBus};
use nimbus_core::jobs::{Job, PRIORITY_INTERACTIVE, PRIORITY_NORMAL};
use nimbus_core::model::{Album, Artist, NewAlbum, NewArtist, NewTrack, Track, TrackStatus};
use nimbus_db::repo::jobs::{EnqueueOpts, ImportPhase, ImportProgress};
use nimbus_db::repo::{albums, artists, jobs, pins, tracks};
use nimbus_db::PgPool;
use nimbus_musicbrainz::{
    cover_url, BulkGroup, MbClient, MbEvent, ReleaseGroupHit, ReleaseTracklist,
};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::error::LibraryError;

type Result<T, E = LibraryError> = std::result::Result<T, E>;

/// Release group'ы с этими типами (primary — `EP`, или secondary) не импортируются при добавлении
/// артиста (по умолчанию; настраивается: `search.skip_secondary_types`).
pub const EXCLUDED_SECONDARY_TYPES: &[&str] = &[
    "EP",
    "Compilation",
    "Live",
    "Remix",
    "DJ-mix",
    "Demo",
    "Soundtrack",
    "Mixtape/Street",
    "Spokenword",
    "Interview",
    "Audiobook",
    "Audio drama",
];

const COVER_SIZE: u16 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryType {
    Artist,
    Album,
    Track,
}

impl LibraryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            LibraryType::Artist => "artist",
            LibraryType::Album => "album",
            LibraryType::Track => "track",
        }
    }

    pub fn entity(&self) -> Entity {
        match self {
            LibraryType::Artist => Entity::Artist,
            LibraryType::Album => Entity::Album,
            LibraryType::Track => Entity::Track,
        }
    }
}

impl std::str::FromStr for LibraryType {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "artist" => Ok(Self::Artist),
            "album" => Ok(Self::Album),
            "track" => Ok(Self::Track),
            _ => Err(()),
        }
    }
}

/// Результат добавления.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddOutcome {
    /// Добавлено (альбом, трек).
    Added { id: i64 },
    /// Артист добавлен, дискография импортируется в фоне.
    Importing { id: i64 },
    /// Уже было в библиотеке.
    Exists { id: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Clone)]
pub struct LibraryService {
    db: PgPool,
    mb: MbClient,
    events: EventBus,
    /// Включена ли автозагрузка (`storage.auto_download = "added"`): добавляемое сразу закрепляется.
    auto_download: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Сколько импорт может не получать от MusicBrainz ни одного события, прежде чем считаться
    /// зависшим (задача перезапускается с паузой, а не висит).
    import_stall: Duration,
}

/// Тишина от MusicBrainz дольше этого (плюс честное ожидание в очереди лимитера и паузы после 503) —
/// импорт считается зависшим и перезапускается. Меньше таймаута одного HTTP-запроса (15 с) делать
/// нельзя: медленный, но живой ответ был бы принят за зависание.
pub const IMPORT_STALL: Duration = Duration::from_secs(20);
/// Как часто в интерфейсе обновляется «ждём ответа N с», пока MusicBrainz молчит.
const IMPORT_HEARTBEAT: Duration = Duration::from_secs(3);
/// Не чаще раза в это время прогресс из потока событий пишется в БД.
const IMPORT_SAVE_EVERY: Duration = Duration::from_millis(400);

/// Попыток задачи `ImportArtist` (с растущей паузой это около получаса).
pub const IMPORT_MAX_ATTEMPTS: i32 = 8;

impl LibraryService {
    /// `mb` задаёт приоритет MB-запросов: для запросов пользователя — обычный клиент,
    /// для фоновых задач — `mb.background()`.
    pub fn new(db: PgPool, mb: MbClient, events: EventBus) -> Self {
        Self {
            db,
            mb,
            events,
            auto_download: None,
            import_stall: IMPORT_STALL,
        }
    }

    /// Подключает проверку автозагрузки: пока она возвращает `true`, всё, что попадает в библиотеку
    /// (альбом, трек, импорт артиста), закрепляется в той же транзакции.
    /// Порог «MusicBrainz молчит» для импорта (по умолчанию [`IMPORT_STALL`]).
    pub fn with_import_stall(mut self, stall: Duration) -> Self {
        self.import_stall = stall;
        self
    }

    pub fn with_auto_download(mut self, f: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        self.auto_download = Some(Arc::new(f));
        self
    }

    fn auto_pin(&self) -> bool {
        self.auto_download.as_ref().is_some_and(|f| f())
    }

    fn changed(&self, entity: Entity, id: i64) {
        self.events.publish(Event::LibraryChanged { entity, id });
    }

    // ------------------------------------------------------------ ensure_*

    /// Артист из БД или (если нет) из MusicBrainz.
    pub async fn ensure_artist(&self, mbid: Uuid) -> Result<Artist> {
        if let Some(a) = artists::get_by_mbid(&self.db, mbid).await? {
            return Ok(a);
        }
        let hit = self.mb.artist(mbid).await?;
        Ok(artists::upsert_by_mbid(
            &self.db,
            &NewArtist {
                mbid: hit.mbid,
                name: hit.name,
                sort_name: hit.sort_name,
                disambiguation: hit.disambiguation,
            },
        )
        .await?)
    }

    /// Альбом с треками: из БД или (если нет альбома либо у него нет треков) из MusicBrainz.
    /// `hint` — уже известные данные release group (экономит запрос).
    pub async fn ensure_album(
        &self,
        rg_mbid: Uuid,
        hint: Option<ReleaseGroupHit>,
    ) -> Result<(Album, Vec<Track>)> {
        self.ensure_album_with(rg_mbid, hint, None).await
    }

    /// `ensure_album`, но если альбома с треками в БД нет, а `prefetched` задан, берёт релиз и
    /// треклист оттуда (пакетный импорт уже получил их из MusicBrainz) — без обращения к сети.
    async fn ensure_album_with(
        &self,
        rg_mbid: Uuid,
        hint: Option<ReleaseGroupHit>,
        prefetched: Option<(Uuid, ReleaseTracklist)>,
    ) -> Result<(Album, Vec<Track>)> {
        if let Some(album) = albums::get_by_rg_mbid(&self.db, rg_mbid).await? {
            let existing = tracks::list_by_album(&self.db, album.id).await?;
            if !existing.is_empty() {
                return Ok((album, existing));
            }
        }

        let rg = match hint {
            Some(h) => h,
            None => self.mb.release_group(rg_mbid).await?,
        };
        let (release, tracklist) = match prefetched {
            Some(p) => p,
            None => self.mb.canonical_release_with_tracklist(rg_mbid).await?,
        };
        self.ensure_album_from(rg, release, &tracklist).await
    }

    /// Записывает альбом и его треки из уже полученных данных MusicBrainz (без сети, кроме
    /// случая, когда артиста нет в БД). Идемпотентно: повторный вызов обновляет те же строки.
    pub async fn ensure_album_from(
        &self,
        rg: ReleaseGroupHit,
        release: Uuid,
        tracklist: &ReleaseTracklist,
    ) -> Result<(Album, Vec<Track>)> {
        let rg_mbid = rg.mbid;
        let artist = self.ensure_artist(rg.artist_mbid).await?;
        let mut tx = self.db.begin().await?;
        let album = albums::upsert_by_rg_mbid(
            &mut *tx,
            &NewAlbum {
                mbid_release_group: rg_mbid,
                mbid_release: Some(release),
                artist_id: artist.id,
                title: rg.title,
                primary_type: rg.primary_type,
                secondary_types: rg.secondary_types,
                year: rg.year,
                cover_url: Some(cover_url(rg_mbid, COVER_SIZE)),
            },
        )
        .await?;
        let mut saved = Vec::with_capacity(tracklist.tracks.len());
        for t in &tracklist.tracks {
            saved.push(
                tracks::upsert_by_mbid_track(
                    &mut *tx,
                    &NewTrack {
                        mbid_recording: t.mbid_recording,
                        mbid_track: Some(t.mbid_track),
                        album_id: album.id,
                        artist_id: artist.id,
                        title: t.title.clone(),
                        disc_no: t.disc_no,
                        position: t.position,
                        duration_ms: t.duration_ms.and_then(|d| i32::try_from(d).ok()),
                    },
                )
                .await?,
            );
        }
        tx.commit().await?;
        Ok((album, saved))
    }

    // ------------------------------------------------------------ add_*

    /// Добавляет альбом целиком и ставит `discover_album`.
    pub async fn add_album(&self, rg_mbid: Uuid) -> Result<AddOutcome> {
        self.add_album_inner(rg_mbid, None, Some(PRIORITY_INTERACTIVE), None)
            .await
    }

    async fn add_album_inner(
        &self,
        rg_mbid: Uuid,
        hint: Option<ReleaseGroupHit>,
        discover: Option<i16>,
        prefetched: Option<(Uuid, ReleaseTracklist)>,
    ) -> Result<AddOutcome> {
        let (album, _) = self.ensure_album_with(rg_mbid, hint, prefetched).await?;
        if album.in_library {
            return Ok(AddOutcome::Exists { id: album.id });
        }

        let mut tx = self.db.begin().await?;
        albums::set_in_library(&mut *tx, album.id, true).await?;
        artists::set_in_library(&mut *tx, album.artist_id, true).await?;
        tracks::set_in_library_for_album(&mut *tx, album.id, true).await?;
        if self.auto_pin() {
            pins::pin_album(&mut tx, album.id).await?;
        }
        let reset = tracks::set_status_for_album(
            &mut *tx,
            album.id,
            &[TrackStatus::NotFound],
            TrackStatus::Adding,
            None,
        )
        .await?;
        // Поиск ставится в той же транзакции: иначе `discover_artist` мог бы увидеть альбом
        // в библиотеке без задачи поиска и объявить его треки ненайденными.
        if let Some(priority) = discover {
            jobs::enqueue(
                &mut *tx,
                &Job::DiscoverAlbum { album_id: album.id },
                EnqueueOpts::priority(priority),
            )
            .await?;
        }
        tx.commit().await?;
        for t in reset {
            self.events.publish(Event::TrackStatus {
                track_id: t.id,
                album_id: t.album_id,
                status: t.status,
                reason: t.status_reason,
            });
        }
        self.changed(Entity::Album, album.id);
        self.changed(Entity::Artist, album.artist_id);
        Ok(AddOutcome::Added { id: album.id })
    }

    /// Добавляет один трек. Альбом подтягивается, но в библиотеку целиком не попадает;
    /// раздачи ищутся по альбому (`discover_album`).
    pub async fn add_track(
        &self,
        recording_mbid: Uuid,
        album_mbid: Option<Uuid>,
    ) -> Result<AddOutcome> {
        let rg_mbid = match album_mbid {
            Some(m) => m,
            None => self
                .mb
                .recording(recording_mbid)
                .await?
                .release_group_mbid
                .ok_or(LibraryError::RecordingNotInRelease)?,
        };
        let (album, album_tracks) = self.ensure_album(rg_mbid, None).await?;
        // Запись может встречаться в альбоме несколько раз — берём первое вхождение.
        let track = album_tracks
            .into_iter()
            .find(|t| t.mbid_recording == recording_mbid)
            .ok_or(LibraryError::RecordingNotInRelease)?;
        if track.in_library {
            return Ok(AddOutcome::Exists { id: track.id });
        }

        let mut tx = self.db.begin().await?;
        tracks::set_in_library(&mut *tx, track.id, true).await?;
        artists::set_in_library(&mut *tx, track.artist_id, true).await?;
        if self.auto_pin() {
            pins::pin_tracks(&mut *tx, &[track.id], false).await?;
        }
        if track.status == TrackStatus::NotFound {
            tracks::set_status(&mut *tx, track.id, TrackStatus::Adding, None).await?;
        }
        tx.commit().await?;

        jobs::enqueue(
            &self.db,
            &Job::DiscoverAlbum { album_id: album.id },
            EnqueueOpts::priority(PRIORITY_INTERACTIVE),
        )
        .await?;
        if track.status == TrackStatus::NotFound {
            self.events.publish(Event::TrackStatus {
                track_id: track.id,
                album_id: track.album_id,
                status: TrackStatus::Adding,
                reason: None,
            });
        }
        self.changed(Entity::Track, track.id);
        self.changed(Entity::Artist, track.artist_id);
        Ok(AddOutcome::Added { id: track.id })
    }

    /// Добавляет артиста; дискографию импортирует фоновая задача `ImportArtist`.
    pub async fn add_artist(&self, mbid: Uuid) -> Result<AddOutcome> {
        let artist = self.ensure_artist(mbid).await?;
        if artist.in_library {
            return Ok(AddOutcome::Exists { id: artist.id });
        }
        artists::set_in_library(&self.db, artist.id, true).await?;
        self.enqueue_import(artist.id).await?;
        self.changed(Entity::Artist, artist.id);
        Ok(AddOutcome::Importing { id: artist.id })
    }

    /// Ставит задачу импорта дискографии (повторно можно вызывать после неудачи: активная задача не дублируется).
    /// Попыток больше обычного: MusicBrainz часто отвечает 503, и импорт должен пережить паузу.
    pub async fn enqueue_import(&self, artist_id: i64) -> Result<()> {
        jobs::enqueue(
            &self.db,
            &Job::ImportArtist { artist_id },
            EnqueueOpts {
                max_attempts: Some(IMPORT_MAX_ATTEMPTS),
                priority: PRIORITY_NORMAL,
                ..EnqueueOpts::default()
            },
        )
        .await?;
        Ok(())
    }

    /// Тело задачи `ImportArtist`: альбомы и EP артиста, кроме отключённых типов,
    /// `discover_artist` ставится в начале (параллельно импорту), `discover_album` — сразу после каждого альбома.
    /// Группы без релизов в MB пропускаются; сетевые ошибки возвращаются (задача повторится,
    /// импорт идемпотентен).
    pub async fn import_artist(&self, artist_id: i64) -> Result<ImportSummary> {
        let skip: Vec<String> = EXCLUDED_SECONDARY_TYPES
            .iter()
            .map(|s| s.to_string())
            .collect();
        self.import_artist_skipping(artist_id, &skip).await
    }

    /// То же, но со своим списком пропускаемых secondary types.
    pub async fn import_artist_skipping(
        &self,
        artist_id: i64,
        skip_secondary_types: &[String],
    ) -> Result<ImportSummary> {
        let artist = artists::get(&self.db, artist_id)
            .await?
            .ok_or(LibraryError::NotFound("artist"))?;
        // Поиск дискографий идёт параллельно импорту альбомов из MusicBrainz.
        jobs::enqueue(
            &self.db,
            &Job::DiscoverArtist { artist_id },
            EnqueueOpts::priority(PRIORITY_NORMAL),
        )
        .await?;
        let started = Instant::now();
        let mut progress = ImportProgress::new();
        progress.log(format!(
            "Requesting the release list and tracklists for {} from MusicBrainz (batched: ~25 releases per request)",
            artist.name
        ));
        self.save_progress(artist_id, &progress).await;

        // Отсеянные группы (тип, чужой артист) в MusicBrainz за треклистами не ходят.
        let skipped_groups = Mutex::new(Vec::<(String, String)>::new());
        // События клиента MusicBrainz идут в прогресс импорта: пользователь видит каждую страницу,
        // повтор после 503 и «ждём ответа N с», а тишина дольше `import_stall` перезапускает задачу.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<MbEvent>();
        let mb = self.mb.with_observer(Arc::new(move |e| {
            // Получатель закрыт, когда импорт уже закончился: событие никому не нужно.
            let _ = tx.send(e);
        }));
        let bulk = {
            let fetch = mb.artist_releases_bulk_filtered(artist.mbid, &["album", "ep"], |group| {
                let excluded = group
                    .primary_type
                    .iter()
                    .chain(group.secondary_types.iter())
                    .find(|t| skip_secondary_types.iter().any(|s| s == *t));
                // Совместные релизы, где первым указан другой артист, не добавляем: иначе в библиотеку
                // попал бы и он.
                let reason = match excluded {
                    Some(t) => Some(format!("type {t}")),
                    None if group.artist_mbid != artist.mbid => {
                        Some("credited to another artist".to_string())
                    }
                    None => None,
                };
                match reason {
                    Some(r) => {
                        skipped_groups
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push((group.title.clone(), r));
                        false
                    }
                    None => true,
                }
            });
            tokio::pin!(fetch);
            let mut heartbeat = tokio::time::interval(IMPORT_HEARTBEAT);
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_activity = Instant::now();
            // До этого момента молчание законно: MusicBrainz попросил подождать (503/429).
            let mut quiet_until = Instant::now();
            let mut last_save = Instant::now();
            let mut step = String::from("Requesting the release list");
            loop {
                tokio::select! {
                    res = &mut fetch => {
                        // Хвост событий, пришедших вместе с ответом, в журнал не нужен.
                        break res?;
                    }
                    Some(event) = rx.recv() => {
                        last_activity = Instant::now();
                        if let MbEvent::Throttled { wait, .. } = &event {
                            quiet_until = last_activity + *wait;
                        }
                        apply_mb_event(&mut progress, &mut step, event);
                        if last_save.elapsed() >= IMPORT_SAVE_EVERY {
                            last_save = Instant::now();
                            self.save_progress(artist_id, &progress).await;
                        }
                    }
                    _ = heartbeat.tick() => {
                        let silent = last_activity.elapsed();
                        if is_stalled(silent, self.import_stall, mb.expected_queue_wait(), Instant::now(), quiet_until) {
                            progress.log(format!(
                                "No response from MusicBrainz for {}s: the import is stuck and will be restarted automatically",
                                silent.as_secs()
                            ));
                            progress.current = None;
                            self.save_progress(artist_id, &progress).await;
                            return Err(LibraryError::MbUnavailable(format!(
                                "no activity from MusicBrainz for {}s (stalled)",
                                silent.as_secs()
                            )));
                        }
                        progress.current = Some(if silent >= Duration::from_secs(3) {
                            format!("{step} — waiting for a response, {}s", silent.as_secs())
                        } else {
                            step.clone()
                        });
                        last_save = Instant::now();
                        self.save_progress(artist_id, &progress).await;
                    }
                }
            }
        };
        let skipped_groups = skipped_groups
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner);

        let mut summary = ImportSummary::default();
        progress.phase = ImportPhase::Albums;
        progress.done = 0;
        progress.current = None;
        progress.total =
            u32::try_from(bulk.groups.len() + bulk.unavailable.len() + skipped_groups.len())
                .unwrap_or(u32::MAX);
        progress.log(format!(
            "Found {} release groups (albums and EPs), {} with tracklists, in {:.1}s",
            progress.total,
            bulk.groups.len(),
            started.elapsed().as_secs_f32()
        ));
        for (title, reason) in skipped_groups {
            summary.skipped += 1;
            progress.skipped += 1;
            progress.done += 1;
            progress.log(format!("Skipped \"{title}\": {reason}"));
        }
        for group in bulk.unavailable {
            tracing::warn!(release_group = %group.mbid, title = %group.title, "release group has no usable release, skipped");
            summary.skipped += 1;
            progress.skipped += 1;
            progress.done += 1;
            progress.log(format!(
                "Skipped \"{}\": no usable release in MusicBrainz",
                group.title
            ));
        }
        self.save_progress(artist_id, &progress).await;

        for BulkGroup {
            group,
            release,
            tracklist,
        } in bulk.groups
        {
            let title = group.title.clone();
            progress.current = Some(title.clone());
            self.save_progress(artist_id, &progress).await;
            let album_started = Instant::now();
            // Запись в БД и постановка `DiscoverAlbum` — сразу, без сети (контракт шага 29).
            let outcome = self
                .add_album_inner(
                    group.mbid,
                    Some(group),
                    Some(PRIORITY_NORMAL),
                    Some((release, tracklist)),
                )
                .await;
            progress.done += 1;
            match outcome {
                Ok(_) => {
                    summary.imported += 1;
                    progress.imported += 1;
                    progress.log(format!(
                        "Added \"{title}\" ({:.1}s)",
                        album_started.elapsed().as_secs_f32()
                    ));
                }
                Err(e) => {
                    progress.log(format!("Error on \"{title}\": {e}"));
                    self.save_progress(artist_id, &progress).await;
                    return Err(e);
                }
            }
            self.save_progress(artist_id, &progress).await;
        }
        progress.phase = ImportPhase::Discover;
        progress.current = None;
        progress.log(format!(
            "Albums imported: {}, skipped: {} ({:.0}s total)",
            summary.imported,
            summary.skipped,
            started.elapsed().as_secs_f32()
        ));
        self.save_progress(artist_id, &progress).await;
        self.changed(Entity::Artist, artist_id);
        Ok(summary)
    }

    /// Сохраняет прогресс импорта и просит UI обновиться. Ошибка записи не должна ронять импорт.
    async fn save_progress(&self, artist_id: i64, progress: &ImportProgress) {
        if let Err(e) = jobs::set_import_progress(&self.db, artist_id, progress).await {
            tracing::warn!(artist_id, error = %e, "failed to save import progress");
        }
        self.changed(Entity::Artist, artist_id);
    }

    // ------------------------------------------------------------ remove

    /// Снимает `in_library` (метаданные и найденные источники остаются).
    pub async fn remove(&self, ty: LibraryType, id: i64) -> Result<()> {
        match ty {
            LibraryType::Artist => {
                let artist = artists::get(&self.db, id)
                    .await?
                    .ok_or(LibraryError::NotFound("artist"))?;
                let mut tx = self.db.begin().await?;
                artists::set_in_library(&mut *tx, id, false).await?;
                albums::set_in_library_for_artist(&mut *tx, id, false).await?;
                tracks::set_in_library_for_artist(&mut *tx, id, false).await?;
                pins::unpin_artist(&mut *tx, id).await?;
                tx.commit().await?;
                self.changed(Entity::Artist, artist.id);
            }
            LibraryType::Album => {
                let album = albums::get(&self.db, id)
                    .await?
                    .ok_or(LibraryError::NotFound("album"))?;
                let mut tx = self.db.begin().await?;
                albums::set_in_library(&mut *tx, id, false).await?;
                tracks::set_in_library_for_album(&mut *tx, id, false).await?;
                pins::unpin_album(&mut *tx, id).await?;
                tx.commit().await?;
                self.changed(Entity::Album, album.id);
            }
            LibraryType::Track => {
                let track = tracks::get(&self.db, id)
                    .await?
                    .ok_or(LibraryError::NotFound("track"))?;
                tracks::set_in_library(&self.db, id, false).await?;
                pins::unpin_track(&self.db, id).await?;
                self.changed(Entity::Track, track.id);
            }
        }
        Ok(())
    }
}

/// Импорт завис? Тишина `silent` законна, пока она не дольше порога `base` плюс честного ожидания
/// в очереди лимитера (`queue_wait`: там стоят и другие импорты, и поиски) и пока не прошла пауза,
/// о которой просил сервер (`quiet_until`).
fn is_stalled(
    silent: Duration,
    base: Duration,
    queue_wait: Duration,
    now: Instant,
    quiet_until: Instant,
) -> bool {
    silent >= base + queue_wait && now >= quiet_until
}

/// Переносит событие клиента MusicBrainz в прогресс импорта: `current` — что делаем сейчас,
/// `log` — то, что пользователю важно увидеть (страницы, повторы).
fn apply_mb_event(progress: &mut ImportProgress, step: &mut String, event: MbEvent) {
    match event {
        MbEvent::Waiting { .. } => {
            *step = "Waiting in the MusicBrainz request queue (1 request per second)".into();
        }
        MbEvent::Sent { what, attempt } => {
            *step = if attempt == 0 {
                format!("Requesting {what} from MusicBrainz")
            } else {
                format!("Requesting {what} from MusicBrainz (retry {attempt})")
            };
        }
        MbEvent::Received { .. } => {}
        MbEvent::Throttled {
            status,
            wait,
            attempt,
            max,
        } => {
            progress.log(format!(
                "MusicBrainz is busy (HTTP {status}); retrying in {}s (retry {attempt} of {max})",
                wait.as_secs().max(1)
            ));
            *step = format!(
                "MusicBrainz is busy, retrying in {}s",
                wait.as_secs().max(1)
            );
        }
        MbEvent::Pages {
            what,
            loaded,
            total,
        } => {
            progress.done = u32::try_from(loaded).unwrap_or(u32::MAX);
            progress.total = u32::try_from(total).unwrap_or(u32::MAX);
            progress.log(format!("Loaded {loaded} of {total} {what}"));
        }
        MbEvent::Fallback { done, total } => {
            progress.done = u32::try_from(done).unwrap_or(u32::MAX);
            progress.total = u32::try_from(total).unwrap_or(u32::MAX);
            if done == 0 {
                progress.log(format!(
                    "Fetching tracklists one release group at a time: {total} left"
                ));
            } else if done == total || done % 5 == 0 {
                progress.log(format!("Tracklists fetched: {done} of {total}"));
            }
        }
    }
}

#[cfg(test)]
mod stall_tests {
    use super::*;

    #[test]
    fn silence_is_legit_while_queued_or_asked_to_wait() {
        let now = Instant::now();
        let base = Duration::from_secs(20);
        let s = Duration::from_secs;
        // Тихо дольше порога, очередь пуста, просьб подождать нет → завис.
        assert!(is_stalled(s(21), base, s(0), now, now));
        // Не дольше порога → нет.
        assert!(!is_stalled(s(19), base, s(0), now, now));
        // Стоим в очереди за пятью запросами по 2 с: порог 30 с, а не 20.
        assert!(!is_stalled(s(25), base, s(10), now, now));
        assert!(is_stalled(s(31), base, s(10), now, now));
        // Сервер просил подождать ещё минуту → пока ждём, не завис.
        assert!(!is_stalled(s(300), base, s(0), now, now + s(60)));
    }
}
