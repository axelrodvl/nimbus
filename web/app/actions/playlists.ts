'use server';

import { updateTag } from 'next/cache';
import { actionFailure } from '@/lib/api/action-errors';
import { api } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/client';
import { unwrap, unwrapEmpty } from '@/lib/api/errors';

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

// Плейлисты зависят и от прослушиваний (Favorites), и от состава треков.
function invalidate() {
  updateTag('playlists');
}

/** Список плейлистов без кэша: порядок зависит от последнего добавления. Favorites — первый. */
export async function loadPlaylists(): Promise<ActionResult<{ playlists: Schemas['PlaylistDto'][] }>> {
  try {
    return { ok: true, playlists: unwrap(await api.GET('/api/playlists')).items };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function createPlaylist(name: string): Promise<ActionResult<{ playlist: Schemas['PlaylistDto'] }>> {
  try {
    const playlist = unwrap(await api.POST('/api/playlists', { body: { name } }));
    invalidate();
    return { ok: true, playlist };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function deletePlaylist(id: string): Promise<ActionResult> {
  try {
    unwrapEmpty(await api.DELETE('/api/playlists/{id}', { params: { path: { id } } }));
    invalidate();
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function addTrackToPlaylist(playlistId: string, trackId: number): Promise<ActionResult> {
  try {
    unwrapEmpty(
      await api.POST('/api/playlists/{id}/tracks', {
        body: { track_id: trackId },
        params: { path: { id: playlistId } },
      }),
    );
    invalidate();
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function removeTrackFromPlaylist(playlistId: string, trackId: number): Promise<ActionResult> {
  try {
    unwrapEmpty(
      await api.DELETE('/api/playlists/{id}/tracks/{track_id}', {
        params: { path: { id: playlistId, track_id: trackId } },
      }),
    );
    invalidate();
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

/** Засчитывает прослушивание (плеер зовёт, когда прослушана заметная часть трека). Ошибки не важны. */
export async function recordPlay(trackId: number): Promise<void> {
  try {
    await api.POST('/api/tracks/{id}/played', { params: { path: { id: trackId } } });
    updateTag('playlists');
    updateTag('library');
  } catch {
    /* счётчик — best effort */
  }
}
