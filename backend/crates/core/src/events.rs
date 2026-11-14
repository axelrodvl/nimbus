//! Внутрипроцессная шина событий (транслируется клиентам через WebSocket).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::Instant;

use crate::model::TrackStatus;

/// Не чаще одного события `acquisition.changed` на альбом за это окно (плюс одно замыкающее).
pub const ACQUISITION_DEBOUNCE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStage {
    Searching,
    Verifying,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Entity {
    Artist,
    Album,
    Track,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "track.status")]
    TrackStatus {
        track_id: i64,
        album_id: i64,
        status: TrackStatus,
        reason: Option<String>,
    },
    #[serde(rename = "job.progress")]
    JobProgress {
        album_id: i64,
        stage: JobStage,
        done: u32,
        total: u32,
    },
    #[serde(rename = "stream.progress")]
    StreamProgress {
        track_id: i64,
        bytes_done: u64,
        bytes_total: u64,
        peers: u32,
        down_speed_bps: u64,
    },
    #[serde(rename = "library.changed")]
    LibraryChanged { entity: Entity, id: i64 },
    /// Могло измениться состояние приобретения альбома (статусы треков, итог поиска): клиенту
    /// стоит перечитать `GET /api/acquisition`. Коалесцируется: [`ACQUISITION_DEBOUNCE`].
    #[serde(rename = "acquisition.changed")]
    AcquisitionChanged { album_id: i64 },
    /// Агрегат по закреплённым загрузкам альбома (раз в секунду, пока они идут).
    #[serde(rename = "download.progress")]
    DownloadProgress {
        album_id: i64,
        bytes_done: u64,
        bytes_total: u64,
        down_bps: u64,
        peers: u32,
    },
}

/// Состояние коалесцирования событий одного альбома.
struct AcqSlot {
    /// Когда событие по альбому последний раз уходило подписчикам.
    last: Instant,
    /// Есть изменение, ещё не отправленное (его отправит замыкающая задача).
    pending: bool,
}

type AcqSlots = Arc<Mutex<HashMap<i64, AcqSlot>>>;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
    acquisition: AcqSlots,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(1024).0,
            acquisition: AcqSlots::default(),
        }
    }

    /// Публикует событие; если подписчиков нет — это не ошибка.
    /// Смена статуса трека заодно сообщает об изменении приобретения его альбома
    /// (см. [`EventBus::publish_acquisition_changed`]).
    pub fn publish(&self, e: Event) {
        let album = match &e {
            Event::TrackStatus { album_id, .. } => Some(*album_id),
            _ => None,
        };
        let _ = self.tx.send(e);
        if let Some(album_id) = album {
            self.publish_acquisition_changed(album_id);
        }
    }

    /// `acquisition.changed` с коалесцированием: первое событие по альбому уходит сразу, остальные
    /// в пределах [`ACQUISITION_DEBOUNCE`] сливаются в одно замыкающее — не больше двух событий
    /// на всплеск. Замыкающая задача живёт не дольше окна и в остановке не нуждается; вне
    /// tokio-рантайма замыкающее событие не отправляется.
    pub fn publish_acquisition_changed(&self, album_id: i64) {
        let now = Instant::now();
        {
            let mut slots = self
                .acquisition
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if slots.len() > 4096 {
                slots.retain(|_, s| s.pending || now.duration_since(s.last) < ACQUISITION_DEBOUNCE);
            }
            if let Some(slot) = slots.get_mut(&album_id) {
                if now.duration_since(slot.last) < ACQUISITION_DEBOUNCE {
                    if !slot.pending {
                        if let Ok(rt) = tokio::runtime::Handle::try_current() {
                            slot.pending = true;
                            let wait = ACQUISITION_DEBOUNCE - now.duration_since(slot.last);
                            let bus = self.clone();
                            rt.spawn(async move {
                                tokio::time::sleep(wait).await;
                                bus.flush_acquisition(album_id);
                            });
                        }
                    }
                    return;
                }
            }
            slots.insert(
                album_id,
                AcqSlot {
                    last: now,
                    pending: false,
                },
            );
        }
        let _ = self.tx.send(Event::AcquisitionChanged { album_id });
    }

    /// Отправляет отложенное событие и открывает новое окно.
    fn flush_acquisition(&self, album_id: i64) {
        {
            let mut slots = self
                .acquisition
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(slot) = slots.get_mut(&album_id) else {
                return;
            };
            if !slot.pending {
                return;
            }
            slot.pending = false;
            slot.last = Instant::now();
        }
        let _ = self.tx.send(Event::AcquisitionChanged { album_id });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_type_tag() {
        let e = Event::TrackStatus {
            track_id: 1,
            album_id: 2,
            status: TrackStatus::NotFound,
            reason: Some("no_match".into()),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "track.status");
        assert_eq!(v["status"], "not_found");
        let v = serde_json::to_value(Event::JobProgress {
            album_id: 1,
            stage: JobStage::Verifying,
            done: 1,
            total: 3,
        })
        .unwrap();
        assert_eq!(
            (v["type"].as_str(), v["stage"].as_str()),
            (Some("job.progress"), Some("verifying"))
        );
        let v = serde_json::to_value(Event::LibraryChanged {
            entity: Entity::Album,
            id: 5,
        })
        .unwrap();
        assert_eq!(v["entity"], "album");
    }

    fn drain(rx: &mut broadcast::Receiver<Event>) -> Vec<Event> {
        let mut out = vec![];
        while let Ok(e) = rx.try_recv() {
            out.push(e);
        }
        out
    }

    fn status(track_id: i64, album_id: i64) -> Event {
        Event::TrackStatus {
            track_id,
            album_id,
            status: TrackStatus::Found,
            reason: None,
        }
    }

    fn acq_count(events: &[Event], album: i64) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, Event::AcquisitionChanged { album_id } if *album_id == album))
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn burst_of_track_changes_yields_at_most_two_acquisition_events() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        for i in 0..20 {
            bus.publish(status(i, 7));
            tokio::time::advance(Duration::from_millis(5)).await;
        }
        tokio::time::advance(ACQUISITION_DEBOUNCE * 2).await;
        tokio::task::yield_now().await;
        let events = drain(&mut rx);
        assert_eq!(acq_count(&events, 7), 2, "первое сразу + одно замыкающее");
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Event::TrackStatus { .. }))
                .count(),
            20,
            "сами track.status не коалесцируются"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn single_change_yields_one_event_and_albums_are_independent() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(status(1, 1));
        bus.publish(status(2, 2));
        tokio::time::advance(ACQUISITION_DEBOUNCE * 2).await;
        tokio::task::yield_now().await;
        let events = drain(&mut rx);
        assert_eq!(acq_count(&events, 1), 1);
        assert_eq!(acq_count(&events, 2), 1);
        // После окна новое изменение снова уходит сразу.
        bus.publish_acquisition_changed(1);
        assert_eq!(acq_count(&drain(&mut rx), 1), 1);
    }

    #[test]
    fn acquisition_event_serializes_with_type_tag() {
        let v = serde_json::to_value(Event::AcquisitionChanged { album_id: 9 }).unwrap();
        assert_eq!(v["type"], "acquisition.changed");
        assert_eq!(v["album_id"], 9);
    }

    #[test]
    fn without_runtime_only_the_leading_event_is_sent() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish_acquisition_changed(1);
        bus.publish_acquisition_changed(1);
        assert_eq!(acq_count(&drain(&mut rx), 1), 1);
    }

    #[test]
    fn publish_without_subscribers_is_ok() {
        let bus = EventBus::new();
        bus.publish(Event::LibraryChanged {
            entity: Entity::Track,
            id: 1,
        });
        let mut rx = bus.subscribe();
        bus.publish(Event::LibraryChanged {
            entity: Entity::Track,
            id: 2,
        });
        assert_eq!(
            rx.try_recv().unwrap(),
            Event::LibraryChanged {
                entity: Entity::Track,
                id: 2
            }
        );
    }
}
