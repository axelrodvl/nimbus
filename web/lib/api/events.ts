import type { Schemas } from './client';

export type TrackStatus = Schemas['TrackStatus'];

// События WebSocket (`/api/ws`) не описаны в OpenAPI, поэтому типы ведутся вручную.
// Источник истины — `backend/crates/core/src/events.rs`.
export type LiveEvent =
  | { type: 'track.status'; track_id: number; album_id: number; status: TrackStatus; reason: string | null }
  | { type: 'job.progress'; album_id: number; stage: 'searching' | 'verifying'; done: number; total: number }
  | {
      type: 'stream.progress';
      track_id: number;
      bytes_done: number;
      bytes_total: number;
      peers: number;
      down_speed_bps: number;
    }
  | { type: 'library.changed'; entity: 'artist' | 'album' | 'track'; id: number }
  | { type: 'resync' };

export type LiveEventType = LiveEvent['type'];

export type LiveEventOf<T extends LiveEventType> = Extract<LiveEvent, { type: T }>;
