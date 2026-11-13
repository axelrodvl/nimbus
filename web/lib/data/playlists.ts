import 'server-only';

import { cacheLife, cacheTag } from 'next/cache';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

// Тег кэша `playlists` инвалидируется при любом изменении плейлистов и при каждом засчитанном прослушивании.

export async function getPlaylists() {
  await connection();
  return fetchPlaylists();
}

async function fetchPlaylists() {
  'use cache';
  cacheTag('playlists');
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  return unwrap(await api.GET('/api/playlists')).items;
}

/** `id` — `favorites` или числовой ID. */
export async function getPlaylist(id: string) {
  if (id !== 'favorites' && !/^\d+$/.test(id)) notFound();
  await connection();
  const data = await fetchPlaylist(id);
  if (!data) notFound();
  return data;
}

// 404 превращается в `null` внутри кэшируемой функции (см. `getAlbum`).
async function fetchPlaylist(id: string) {
  'use cache';
  cacheTag('playlists', 'library');
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  const res = await api.GET('/api/playlists/{id}', { params: { path: { id } } });
  return res.response.status === 404 ? null : unwrap(res);
}
