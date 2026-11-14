import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import {
  getAcquisitionSummary,
  getDownloads,
  getFailedJobs,
  listAcquisition,
  pinAlbumRequest,
  pinTrackRequest,
  retryAcquisitionRequest,
  retryJobRequest,
  setPausedAll,
  setTorrentPaused,
  unpinAlbumRequest,
  unpinTrackRequest,
} from './acquisition';
import { ApiError } from './errors';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

function client(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => response());
  const api = createApiClient({ baseUrl: 'http://x', fetch });
  const last = async () => {
    const req = fetch.mock.calls.at(-1)?.[0] as Request;
    const text = await req.clone().text();
    const url = new URL(req.url);
    return {
      body: text ? (JSON.parse(text) as unknown) : null,
      method: req.method,
      path: url.pathname,
      query: url.search,
    };
  };
  return { api, last };
}

describe('API приобретения и загрузок', () => {
  it('список: состояния и album_ids — через запятую, курсор и размер страницы 100', async () => {
    const { api, last } = client(() => json({ items: [], next_cursor: null }));
    await listAcquisition({ albumIds: [3, 4], cursor: 'c1', states: ['missing', 'partial'] }, undefined, api);
    expect(await last()).toMatchObject({
      method: 'GET',
      path: '/api/acquisition',
      query: '?album_ids=3%2C4&cursor=c1&limit=100&state=missing%2Cpartial',
    });
    await listAcquisition({}, undefined, api);
    expect((await last()).query).toBe('?limit=100');
  });

  it('сводка, торренты движка, упавшие задачи', async () => {
    const { api, last } = client(() => json({}));
    await getAcquisitionSummary(undefined, api);
    expect((await last()).path).toBe('/api/acquisition/summary');
    await getDownloads(undefined, api);
    expect((await last()).path).toBe('/api/downloads');
    await getFailedJobs(undefined, api);
    expect(await last()).toMatchObject({ path: '/api/jobs', query: '?limit=200&state=failed' });
  });

  it('повтор поиска возвращает число; повтор задачи — POST по id', async () => {
    const { api, last } = client(() => json({ queued: 7 }, 202));
    expect(await retryAcquisitionRequest({ reset_dead: true, scope: 'missing' }, api)).toBe(7);
    expect(await last()).toMatchObject({
      body: { reset_dead: true, scope: 'missing' },
      method: 'POST',
      path: '/api/acquisition/retry',
    });
    await retryJobRequest(12, api);
    expect(await last()).toMatchObject({ method: 'POST', path: '/api/jobs/12/retry' });
  });

  it('закрепление альбома и трека: POST/DELETE, delete_files в запросе', async () => {
    const { api, last } = client(() => json({ pinned: 2 }));
    expect(await pinAlbumRequest(5, api)).toEqual({ pinned: 2 });
    expect(await last()).toMatchObject({ method: 'POST', path: '/api/albums/5/download' });
    await pinTrackRequest(9, api);
    expect(await last()).toMatchObject({ method: 'POST', path: '/api/tracks/9/download' });

    const empty = client(() => new Response(null, { status: 204 }));
    await unpinAlbumRequest(5, true, empty.api);
    expect(await empty.last()).toMatchObject({
      method: 'DELETE',
      path: '/api/albums/5/download',
      query: '?delete_files=true',
    });
    await unpinTrackRequest(9, false, empty.api);
    expect(await empty.last()).toMatchObject({
      method: 'DELETE',
      path: '/api/tracks/9/download',
      query: '?delete_files=false',
    });
  });

  it('пауза всех возвращает состояние из ответа; пауза торрента — по info_hash', async () => {
    const all = client(() => json({ paused: true }));
    expect(await setPausedAll(true, all.api)).toBe(true);
    expect((await all.last()).path).toBe('/api/downloads/pause-all');
    await setPausedAll(false, all.api);
    expect((await all.last()).path).toBe('/api/downloads/resume-all');
    const one = client(() => new Response(null, { status: 204 }));
    await setTorrentPaused('abc', true, one.api);
    expect((await one.last()).path).toBe('/api/downloads/abc/pause');
    await setTorrentPaused('abc', false, one.api);
    expect((await one.last()).path).toBe('/api/downloads/abc/resume');
  });

  it('ошибки сервера превращаются в ApiError с кодом', async () => {
    const { api } = client(() => json({ error: { code: 'duplicate', message: 'dup' } }, 409));
    await expect(retryJobRequest(1, api)).rejects.toMatchObject({ code: 'duplicate', status: 409 });
    await expect(retryJobRequest(1, api)).rejects.toBeInstanceOf(ApiError);
    const gone = client(() => json({ error: { code: 'not_found', message: 'no' } }, 404));
    await expect(unpinAlbumRequest(1, false, gone.api)).rejects.toMatchObject({ status: 404 });
  });
});
