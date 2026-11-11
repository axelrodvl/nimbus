//! Внутрипроцессная шина событий (транслируется клиентам через WebSocket).

use serde::Serialize;
use tokio::sync::broadcast;

use crate::model::TrackStatus;

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
}

#[derive(Clone)]
pub struct EventBus(broadcast::Sender<Event>);

impl EventBus {
    pub fn new() -> Self {
        Self(broadcast::channel(1024).0)
    }

    /// Публикует событие; если подписчиков нет — это не ошибка.
    pub fn publish(&self, e: Event) {
        let _ = self.0.send(e);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.subscribe()
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
