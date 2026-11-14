import { describe, expect, it, vi } from 'vitest';
import type { TFn } from '@/lib/i18n/messages';
import { en as enMessages } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import { apiErrorMessage } from './error-message';
import { ApiError } from './errors';
import {
  addPlaylistTrackRequest,
  createPlaylistRequest,
  deletePlaylistRequest,
  removePlaylistTrackRequest,
} from './playlists';
import {
  addMagnetRequest,
  confirmSourceRequest,
  getAlbumTorrents,
  getTorrentFiles,
  getTrackSources,
  retryAlbumRequest,
  retryTrackRequest,
  setTrackSourceRequest,
} from './sources';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

function client(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => response());
  const api = createApiClient({ baseUrl: 'http://x', fetch });
  const last = async () => {
    const req = fetch.mock.calls.at(-1)?.[0] as Request;
    const text = await req.clone().text();
    return { body: text ? (JSON.parse(text) as unknown) : null, method: req.method, path: new URL(req.url).pathname };
  };
  return { api, last };
}

describe('API плейлистов', () => {
  it('create: строковый id сервера → число', async () => {
    const { api, last } = client(() =>
      json({ created_at: '2026-01-01T00:00:00Z', id: '12', kind: 'user', name: 'Mix', track_count: 0 }, 201),
    );
    expect(await createPlaylistRequest('Mix', api)).toEqual({ created_at: '2026-01-01T00:00:00Z', id: 12, name: 'Mix' });
    expect(await last()).toEqual({ body: { name: 'Mix' }, method: 'POST', path: '/api/playlists' });
  });

  it('create: нет created_at — подставляется текущее время', async () => {
    const { api } = client(() => json({ id: '3', kind: 'user', name: 'A', track_count: 0 }, 201));
    const created = await createPlaylistRequest('A', api);
    expect(Number.isNaN(Date.parse(created.created_at))).toBe(false);
  });

  it('delete / add / remove: пути и тела', async () => {
    const { api, last } = client(() => new Response(null, { status: 204 }));
    await deletePlaylistRequest(5, api);
    expect(await last()).toMatchObject({ method: 'DELETE', path: '/api/playlists/5' });
    await addPlaylistTrackRequest(5, 9, api);
    expect(await last()).toEqual({ body: { track_id: 9 }, method: 'POST', path: '/api/playlists/5/tracks' });
    await removePlaylistTrackRequest(5, 9, api);
    expect(await last()).toMatchObject({ method: 'DELETE', path: '/api/playlists/5/tracks/9' });
  });

  it('409/404 → ApiError с кодом', async () => {
    const { api } = client(() => errorResponse(409, 'playlist_dynamic', 'no'));
    await expect(deletePlaylistRequest(1, api)).rejects.toMatchObject({ code: 'playlist_dynamic', status: 409 });
  });
});

describe('API источников', () => {
  it('чтение: торренты альбома, источники трека, файлы раздачи', async () => {
    const { api, last } = client(() => json([]));
    expect(await getAlbumTorrents(3, undefined, api)).toEqual([]);
    expect((await last()).path).toBe('/api/albums/3/torrents');
    await getTrackSources(4, undefined, api);
    expect((await last()).path).toBe('/api/tracks/4/sources');
    await getTorrentFiles(5, undefined, api);
    expect((await last()).path).toBe('/api/torrents/5/files');
  });

  it('выбор источника: оба вида тела', async () => {
    const { api, last } = client(() => json({}));
    await setTrackSourceRequest(4, { source_id: 8 }, api);
    expect(await last()).toEqual({ body: { source_id: 8 }, method: 'PUT', path: '/api/tracks/4/source' });
    await setTrackSourceRequest(4, { file_index: 2, torrent_id: 9 }, api);
    expect((await last()).body).toEqual({ file_index: 2, torrent_id: 9 });
  });

  it('подтверждение, повтор трека/альбома, magnet', async () => {
    const { api, last } = client(() => json({ queued: true, tracks_reset: 1 }, 202));
    await confirmSourceRequest(4, 8, api);
    expect(await last()).toMatchObject({ method: 'POST', path: '/api/tracks/4/sources/8/confirm' });
    expect(await retryTrackRequest(4, api)).toEqual({ queued: true, tracks_reset: 1 });
    expect((await last()).path).toBe('/api/tracks/4/retry');
    await retryAlbumRequest(3, api);
    expect((await last()).path).toBe('/api/albums/3/retry');
    await addMagnetRequest(3, 'magnet:?xt=urn:btih:x', api);
    expect(await last()).toEqual({ body: { magnet: 'magnet:?xt=urn:btih:x' }, method: 'POST', path: '/api/albums/3/torrents' });
  });

  it('ошибка сервера → ApiError', async () => {
    const { api } = client(() => errorResponse(400, 'invalid_magnet', 'bad'));
    await expect(addMagnetRequest(1, 'x', api)).rejects.toMatchObject({ code: 'invalid_magnet', status: 400 });
  });
});

describe('apiErrorMessage', () => {
  const t: TFn = (key, params) => translate(enMessages, 'en', key, params);
  it('код с переводом → перевод; без перевода → сообщение сервера', () => {
    expect(apiErrorMessage(new ApiError(0, 'offline', 'You are offline'), t)).toBe(enMessages['error.offline']);
    expect(apiErrorMessage(new ApiError(502, 'weird_code', 'server says'), t)).toBe('server says');
  });
  it('ошибка без кода → общее сообщение; обычная ошибка и строка — как есть', () => {
    expect(apiErrorMessage(new ApiError(500, 'unknown', 'Internal Server Error'), t)).toBe(enMessages['common.loadFailed']);
    expect(apiErrorMessage(new Error('plain'), t)).toBe('plain');
    expect(apiErrorMessage('str', t)).toBe('str');
  });
});
