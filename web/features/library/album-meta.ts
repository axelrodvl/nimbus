import type { Schemas } from '@/lib/api/client';

export function albumMeta(a: Schemas['AlbumDto']) {
  return [a.artist_name, a.year ? String(a.year) : null, a.primary_type].filter(Boolean).join(' · ');
}
