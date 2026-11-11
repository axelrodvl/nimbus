import type { Schemas } from '@/lib/api/client';
import type { Track } from '@/types/track';

export type TrackDto = Schemas['TrackDto'];

export function toPlayerTrack(t: TrackDto): Track {
  return {
    album: t.album_title,
    artist: t.artist_name,
    coverUrl: t.cover_url ?? null,
    durationMs: t.duration_ms ?? null,
    id: t.id,
    status: t.status,
    title: t.title,
  };
}
