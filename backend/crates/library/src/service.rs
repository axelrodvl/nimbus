use nimbus_core::events::{Entity, Event, EventBus};
use nimbus_core::jobs::Job;
use nimbus_core::model::{Album, Artist, NewAlbum, NewArtist, NewTrack, Track, TrackStatus};
use nimbus_db::repo::{albums, artists, jobs, tracks};
use nimbus_db::PgPool;
use nimbus_musicbrainz::{cover_url, MbClient, ReleaseGroupHit};
use uuid::Uuid;

use crate::error::LibraryError;

type Result<T, E = LibraryError> = std::result::Result<T, E>;

/// Release group'ы с этими secondary types не импортируются при добавлении артиста
/// (позже станет настройкой).
pub const EXCLUDED_SECONDARY_TYPES: &[&str] = &["Compilation", "Live", "Remix", "DJ-mix", "Demo"];

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
}

impl LibraryService {
    /// `mb` задаёт приоритет MB-запросов: для запросов пользователя — обычный клиент,
    /// для фоновых задач — `mb.background()`.
    pub fn new(db: PgPool, mb: MbClient, events: EventBus) -> Self {
        Self { db, mb, events }
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
        let artist = self.ensure_artist(rg.artist_mbid).await?;
        let release = self.mb.pick_canonical_release(rg_mbid).await?;
        let tracklist = self.mb.release_tracklist(release).await?;

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
        self.add_album_inner(rg_mbid, None, true).await
    }

    async fn add_album_inner(
        &self,
        rg_mbid: Uuid,
        hint: Option<ReleaseGroupHit>,
        discover: bool,
    ) -> Result<AddOutcome> {
        let (album, _) = self.ensure_album(rg_mbid, hint).await?;
        if album.in_library {
            return Ok(AddOutcome::Exists { id: album.id });
        }

        let mut tx = self.db.begin().await?;
        albums::set_in_library(&mut *tx, album.id, true).await?;
        artists::set_in_library(&mut *tx, album.artist_id, true).await?;
        tracks::set_in_library_for_album(&mut *tx, album.id, true).await?;
        let reset = tracks::set_status_for_album(
            &mut *tx,
            album.id,
            &[TrackStatus::NotFound],
            TrackStatus::Adding,
            None,
        )
        .await?;
        tx.commit().await?;

        if discover {
            jobs::enqueue(&self.db, &Job::DiscoverAlbum { album_id: album.id }, None).await?;
        }
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
        if track.status == TrackStatus::NotFound {
            tracks::set_status(&mut *tx, track.id, TrackStatus::Adding, None).await?;
        }
        tx.commit().await?;

        jobs::enqueue(&self.db, &Job::DiscoverAlbum { album_id: album.id }, None).await?;
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
        jobs::enqueue(
            &self.db,
            &Job::ImportArtist {
                artist_id: artist.id,
            },
            None,
        )
        .await?;
        self.changed(Entity::Artist, artist.id);
        Ok(AddOutcome::Importing { id: artist.id })
    }

    /// Тело задачи `ImportArtist`: альбомы и EP артиста без Compilation/Live/Remix/DJ-mix/Demo,
    /// каждый добавляется без `discover_album`; в конце — `discover_artist`.
    /// Группы без релизов в MB пропускаются; сетевые ошибки возвращаются (задача повторится,
    /// импорт идемпотентен).
    pub async fn import_artist(&self, artist_id: i64) -> Result<ImportSummary> {
        let artist = artists::get(&self.db, artist_id)
            .await?
            .ok_or(LibraryError::NotFound("artist"))?;
        let groups = self
            .mb
            .artist_release_groups(artist.mbid, &["album", "ep"])
            .await?;

        let mut summary = ImportSummary::default();
        for group in groups {
            let excluded = group
                .secondary_types
                .iter()
                .any(|t| EXCLUDED_SECONDARY_TYPES.contains(&t.as_str()));
            // Совместные релизы, где первым указан другой артист, не добавляем: иначе в библиотеку
            // попал бы и он.
            if excluded || group.artist_mbid != artist.mbid {
                summary.skipped += 1;
                continue;
            }
            let (title, rg) = (group.title.clone(), group.mbid);
            match self.add_album_inner(rg, Some(group), false).await {
                Ok(_) => summary.imported += 1,
                Err(LibraryError::MbNotFound) => {
                    tracing::warn!(release_group = %rg, %title, "release group has no usable release, skipped");
                    summary.skipped += 1;
                }
                Err(e) => return Err(e),
            }
        }
        jobs::enqueue(&self.db, &Job::DiscoverArtist { artist_id }, None).await?;
        self.changed(Entity::Artist, artist_id);
        Ok(summary)
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
                tx.commit().await?;
                self.changed(Entity::Album, album.id);
            }
            LibraryType::Track => {
                let track = tracks::get(&self.db, id)
                    .await?
                    .ok_or(LibraryError::NotFound("track"))?;
                tracks::set_in_library(&self.db, id, false).await?;
                self.changed(Entity::Track, track.id);
            }
        }
        Ok(())
    }
}
