'use server';

import { updateTag } from 'next/cache';
import { api } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/client';
import { ApiError, unwrap } from '@/lib/api/errors';

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const MESSAGES: Record<string, string> = {
  backend_unavailable: 'Бэкенд недоступен, попробуйте позже',
  invalid_magnet: 'Это не magnet-ссылка',
  track_ready: 'Трек уже скачан',
};

function failure(e: unknown): { ok: false; code: string; message: string } {
  if (e instanceof ApiError) return { code: e.code, message: MESSAGES[e.code] ?? e.message, ok: false };
  return { code: 'backend_unavailable', message: MESSAGES.backend_unavailable, ok: false };
}

function invalidate(albumId: number, trackId?: number) {
  updateTag('library');
  updateTag(`album:${albumId}`);
  if (trackId !== undefined) updateTag(`track:${trackId}`);
}

// ---- чтение (без кэша: источники меняются по ходу проверки)

export async function loadTrackSources(
  trackId: number,
): Promise<ActionResult<{ sources: Schemas['TrackSourceDto'][] }>> {
  try {
    return {
      ok: true,
      sources: unwrap(await api.GET('/api/tracks/{id}/sources', { params: { path: { id: trackId } } })),
    };
  } catch (e) {
    return failure(e);
  }
}

export async function loadAlbumTorrents(
  albumId: number,
): Promise<ActionResult<{ torrents: Schemas['AlbumTorrentDto'][] }>> {
  try {
    return {
      ok: true,
      torrents: unwrap(await api.GET('/api/albums/{id}/torrents', { params: { path: { id: albumId } } })),
    };
  } catch (e) {
    return failure(e);
  }
}

export async function loadTorrentFiles(
  torrentId: number,
): Promise<ActionResult<{ files: Schemas['TorrentFileDto'][] }>> {
  try {
    return {
      files: unwrap(await api.GET('/api/torrents/{id}/files', { params: { path: { id: torrentId } } })),
      ok: true,
    };
  } catch (e) {
    return failure(e);
  }
}

// ---- мутации

export type SourceChoice = { source_id: number } | { torrent_id: number; file_index: number };

export async function setTrackSource(trackId: number, albumId: number, choice: SourceChoice): Promise<ActionResult> {
  try {
    unwrap(await api.PUT('/api/tracks/{id}/source', { body: choice, params: { path: { id: trackId } } }));
    invalidate(albumId, trackId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function confirmTrackSource(trackId: number, albumId: number, sourceId: number): Promise<ActionResult> {
  try {
    unwrap(
      await api.POST('/api/tracks/{id}/sources/{source_id}/confirm', {
        params: { path: { id: trackId, source_id: sourceId } },
      }),
    );
    invalidate(albumId, trackId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function retryTrack(trackId: number, albumId: number): Promise<ActionResult> {
  try {
    unwrap(await api.POST('/api/tracks/{id}/retry', { params: { path: { id: trackId } } }));
    invalidate(albumId, trackId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function retryAlbum(albumId: number): Promise<ActionResult> {
  try {
    unwrap(await api.POST('/api/albums/{id}/retry', { params: { path: { id: albumId } } }));
    invalidate(albumId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function addMagnet(albumId: number, magnet: string): Promise<ActionResult> {
  try {
    unwrap(await api.POST('/api/albums/{id}/torrents', { body: { magnet }, params: { path: { id: albumId } } }));
    invalidate(albumId);
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}
