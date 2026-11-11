import type { Schemas } from '@/lib/api/client';
import type { Track } from '@/types/track';

export type TrackDto = Schemas['TrackDto'];

export function toPlayerTrack(t: TrackDto): Track {
  return {
    album: t.album_title,
    albumId: t.album_id,
    artist: t.artist_name,
    artistId: t.artist_id,
    coverUrl: t.cover_url ?? null,
    durationMs: t.duration_ms ?? null,
    id: t.id,
    status: t.status,
    title: t.title,
  };
}
