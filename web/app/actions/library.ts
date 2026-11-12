'use server';

import { updateTag } from 'next/cache';
import { actionFailure } from '@/lib/api/action-errors';
import { api } from '@/lib/api/client';
import { unwrap, unwrapEmpty } from '@/lib/api/errors';

export type AddToLibraryInput =
  | { type: 'artist'; mbid: string }
  | { type: 'album'; mbid: string }
  | { type: 'track'; mbid: string; album_mbid?: string | null };

export type LibraryType = 'artist' | 'album' | 'track';

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

export type AddResult = ActionResult<{
  type: LibraryType;
  id: number;
  /** Для треков — альбом в библиотеке (чтобы сразу перейти к нему). */
  albumId?: number;
  status: 'added' | 'importing' | 'exists';
}>;

const TAG_PATTERN = /^(library|(artist|album|track):\d+)$/;

// Инвалидирует теги кэша данных библиотеки (вызывается и после мутаций, и из LiveLibrarySync).
export async function revalidateLibrary(tags: string[]): Promise<void> {
  for (const tag of new Set(tags)) {
    if (TAG_PATTERN.test(tag)) updateTag(tag);
  }
}

export async function addToLibrary(input: AddToLibraryInput): Promise<AddResult> {
  try {
    const body =
      input.type === 'track'
        ? { album_mbid: input.album_mbid ?? null, mbid: input.mbid, type: 'track' as const }
        : { mbid: input.mbid, type: input.type };
    const data = unwrap(await api.POST('/api/library', { body }));
    updateTag('library');
    if (data.type === 'artist' || data.type === 'album') updateTag(`${data.type}:${data.id}`);
    let albumId: number | undefined;
    if (data.type === 'track') {
      const track = await api.GET('/api/tracks/{id}', { params: { path: { id: data.id } } });
      albumId = track.data?.album_id;
      updateTag('library');
      if (albumId != null) updateTag(`album:${albumId}`);
    }
    return { albumId, id: data.id, ok: true, status: data.status, type: data.type };
  } catch (e) {
    return actionFailure(e);
  }
}

/** Повторный импорт дискографии (после неудачи или зависшей попытки). */
export async function retryArtistImport(artistId: number): Promise<ActionResult> {
  try {
    unwrapEmpty(await api.POST('/api/artists/{id}/import', { params: { path: { id: artistId } } }));
    updateTag('library');
    updateTag(`artist:${artistId}`);
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function removeFromLibrary(type: LibraryType, id: number): Promise<ActionResult> {
  try {
    unwrapEmpty(await api.DELETE('/api/library/{type}/{id}', { params: { path: { id, type } } }));
    updateTag('library');
    updateTag(`${type}:${id}`);
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

// Страницы для кнопок «Показать ещё» / "Show more" (без кэша: курсоры уникальны).
export async function loadMoreArtists(cursor: string) {
  return unwrap(await api.GET('/api/library/artists', { params: { query: { cursor, limit: 50 } } }));
}

export async function loadMoreAlbums(cursor: string) {
  return unwrap(await api.GET('/api/library/albums', { params: { query: { cursor, limit: 50 } } }));
}

export async function loadMoreTracks(statuses: string, cursor: string) {
  return unwrap(
    await api.GET('/api/library/tracks', {
      params: { query: { cursor, limit: 100, status: statuses || undefined } },
    }),
  );
}
