import 'server-only';

import { cacheLife, cacheTag } from 'next/cache';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

// Теги кэша: `library` (всё), `artist:{id}`, `album:{id}`, `track:{id}`.
// Статусы треков меняются часто, поэтому жизнь кэша короткая.
const PAGE_ALBUMS = 50;
const PAGE_TRACKS = 100;

// Данные библиотеки живые: `connection()` исключает их из пререндера (бэкенд может быть недоступен
// при сборке), а `'use cache'` внутри дальше кэширует ответ по тегам.

export async function getLibraryArtists(cursor?: string, limit = PAGE_ALBUMS) {
  await connection();
  return fetchArtists(cursor, limit);
}

async function fetchArtists(cursor: string | undefined, limit: number) {
  'use cache';
  cacheTag('library');
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  return unwrap(await api.GET('/api/library/artists', { params: { query: { cursor, limit } } }));
}

export async function getLibraryAlbums(cursor?: string, limit = PAGE_ALBUMS) {
  await connection();
  return fetchAlbums(cursor, limit);
}

async function fetchAlbums(cursor: string | undefined, limit: number) {
  'use cache';
  cacheTag('library');
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  return unwrap(await api.GET('/api/library/albums', { params: { query: { cursor, limit } } }));
}

/** `statuses` — через запятую (`found,ready`); пусто — все. */
export async function getLibraryTracks(statuses = '', cursor?: string, limit = PAGE_TRACKS) {
  await connection();
  return fetchTracks(statuses, cursor, limit);
}

async function fetchTracks(statuses: string, cursor: string | undefined, limit: number) {
  'use cache';
  cacheTag('library');
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  return unwrap(
    await api.GET('/api/library/tracks', {
      params: { query: { cursor, limit, status: statuses || undefined } },
    }),
  );
}

function parseId(id: string) {
  if (!/^\d+$/.test(id)) notFound();
  return Number(id);
}

// 404 превращается в `null` внутри кэшируемой функции: ошибки, брошенные через границу `'use cache'`,
// теряют свой класс, поэтому `instanceof ApiError` снаружи ненадёжен. Любой `add` инвалидирует тег `library`.
export async function getArtist(id: string) {
  const numeric = parseId(id);
  await connection();
  const data = await fetchArtist(numeric);
  if (!data) notFound();
  return data;
}

async function fetchArtist(id: number) {
  'use cache';
  cacheTag('library', `artist:${id}`);
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  const res = await api.GET('/api/artists/{id}', { params: { path: { id } } });
  return res.response.status === 404 ? null : unwrap(res);
}

export async function getAlbum(id: string) {
  const numeric = parseId(id);
  await connection();
  const data = await fetchAlbum(numeric);
  if (!data) notFound();
  return data;
}

async function fetchAlbum(id: number) {
  'use cache';
  cacheTag('library', `album:${id}`);
  cacheLife({ expire: 300, revalidate: 10, stale: 5 });
  const res = await api.GET('/api/albums/{id}', { params: { path: { id } } });
  return res.response.status === 404 ? null : unwrap(res);
}
