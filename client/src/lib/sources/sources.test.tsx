import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as sourcesApi from '@/lib/api/sources';
import { appData } from '@/lib/app-data';
import { resetPlayer, toPlayerTrack } from '@/lib/player';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { installTestPlayer, seedPlayerLibrary } from '@/test/player-ui';
import { seed } from '@/test/seed';
import { en as enMessages } from '@/lib/i18n/messages/en';
import type { TFn } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import {
  addAlbumMagnet,
  chooseTrackSource,
  confirmTrackSource,
  retryAlbumSearch,
  retryTrackSearch,
  selectAlbumTorrent,
  type SourceRequests,
} from './actions';
import { formatSize, kindLabel, metaLabel, sourceLabel } from './format';
import { useAlbumTorrents, useSourcesRefresh } from './hooks';
import { SOURCES_REFRESH_DEBOUNCE_MS, albumTorrentsKey, trackSourcesKey } from './keys';
import { checkMagnet } from './magnet';

vi.mock('@/lib/api/sources', async importOriginal => ({
  ...(await importOriginal<typeof sourcesApi>()),
  getAlbumTorrents: vi.fn(async () => []),
}));

const t: TFn = (key, params) => translate(enMessages, 'en', key, params);

describe('checkMagnet', () => {
  const HEX = '0123456789abcdef0123456789abcdef01234567';
  it('валидные: hex-хеш и base32', () => {
    expect(checkMagnet(`magnet:?xt=urn:btih:${HEX}&dn=Album`)).toBe('ok');
    expect(checkMagnet(`  MAGNET:?xt=urn:btih:${HEX.toUpperCase()}  `)).toBe('ok');
    expect(checkMagnet('magnet:?dn=a&xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe('ok');
  });
  it('пустая строка — empty', () => {
    expect(checkMagnet('')).toBe('empty');
    expect(checkMagnet('   ')).toBe('empty');
  });
  it('без xt, не magnet, короткий хеш — format', () => {
    expect(checkMagnet('magnet:?dn=only-name')).toBe('format');
    expect(checkMagnet('http://example.com')).toBe('format');
    expect(checkMagnet('magnet:?xt=urn:btih:abc')).toBe('format');
    expect(checkMagnet('magnet:?xt=urn:sha1:' + HEX)).toBe('format');
    expect(checkMagnet('magnet:?xt=urn:btih:' + HEX.replace('0', 'z'))).toBe('format');
  });
});

describe('форматирование источников', () => {
  it('размер: единицы, округление, нет значения', () => {
    expect(formatSize(null, t)).toBe('—');
    expect(formatSize(512, t)).toBe('512 B');
    expect(formatSize(1536, t)).toBe('1.5 KB');
    expect(formatSize(20 * 1024 * 1024, t)).toBe('20 MB');
    expect(formatSize(5 * 1024 ** 5, t)).toMatch(/TB$/);
  });
  it('источник, тип, статус метаданных', () => {
    expect(sourceLabel('manual', t)).toBe('Manual');
    expect(sourceLabel('rutracker', t)).toBe('RuTracker');
    expect(sourceLabel('other', t)).toBe('other');
    expect(kindLabel('discography', t)).toBe('Discography');
    expect(kindLabel('unknown', t)).toBe('—');
    for (const [status, text] of [
      ['pending', 'Pending'],
      ['fetching', 'Fetching metadata…'],
      ['ok', 'Metadata received'],
      ['timeout', 'No response'],
      ['dead', 'Dead'],
      ['error', 'Error'],
      ['weird', 'weird'],
    ]) {
      expect(metaLabel(status!, t)).toBe(text);
    }
  });
});

describe('мутации источников', () => {
  const requests = (over: Partial<SourceRequests> = {}): SourceRequests => ({
    addMagnet: vi.fn(async () => ({ queued: true, torrent: {} as never })),
    confirm: vi.fn(async () => ({}) as never),
    retryAlbum: vi.fn(async () => ({ queued: true, tracks_reset: 2 })),
    retryTrack: vi.fn(async () => ({ queued: true, tracks_reset: 1 })),
    selectTorrent: vi.fn(async () => ({
      matched: 2,
      switched_track_ids: [10, 11],
      unmatched: 0,
      image_downloading: false,
    })),
    setSource: vi.fn(async () => ({}) as never),
    ...over,
  });
  let queryClient: QueryClient;
  let invalidate: MockInstance<QueryClient['invalidateQueries']>;
  let sync: MockInstance<() => void>;

  beforeEach(() => {
    resetFactories();
    seedPlayerLibrary();
    queryClient = new QueryClient();
    invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    sync = vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
  });
  afterEach(() => resetPlayer(true));

  it('выбор источника: запрос → инвалидация альбома и трека → синхронизация', async () => {
    const r = requests();
    await chooseTrackSource(10, 2, { source_id: 5 }, { queryClient, requests: r });
    expect(r.setSource).toHaveBeenCalledWith(10, { source_id: 5 });
    const keys = invalidate.mock.calls.map(c => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(albumTorrentsKey(2));
    expect(keys).toContainEqual(trackSourcesKey(10));
    expect(sync).toHaveBeenCalledWith('sources');
  });

  it('ошибка сервера пробрасывается, синхронизации и перезапуска нет', async () => {
    const { ctl, engine } = installTestPlayer();
    ctl.play(toPlayerTrack(appData().selectors.trackView(appData().library.getState(), 10)!));
    const loads = engine.loads.length;
    const r = requests({ setSource: vi.fn().mockRejectedValue(new ApiError(400, 'bad', 'no')) });
    await expect(chooseTrackSource(10, 2, { source_id: 5 }, { queryClient, requests: r })).rejects.toMatchObject({
      code: 'bad',
    });
    expect(sync).not.toHaveBeenCalled();
    expect(engine.loads).toHaveLength(loads);
  });

  it('смена источника играющего трека перезапускает поток с текущей позиции', async () => {
    const { ctl, engine } = installTestPlayer();
    const track = appData().selectors.trackView(appData().library.getState(), 10)!;
    ctl.play(toPlayerTrack(track));
    engine.emit({ type: 'playing' });
    engine.setPosition(33, 100);
    const loads = engine.loads.length;
    await chooseTrackSource(10, 2, { source_id: 5 }, { queryClient, requests: requests() });
    expect(engine.loads).toHaveLength(loads + 1);
    expect(engine.lastLoad?.opts.startAt).toBe(33);
  });

  it('выбор раздачи альбома: устаревшие копии на устройстве удаляются, играющий трек перезапускается', async () => {
    const { ctl, engine } = installTestPlayer();
    ctl.play(toPlayerTrack(appData().selectors.trackView(appData().library.getState(), 10)!));
    engine.emit({ type: 'playing' });
    engine.setPosition(12, 100);
    const loads = engine.loads.length;
    const r = requests();
    const markStale = vi.fn();
    const result = await selectAlbumTorrent(2, 7, { markStale, queryClient, requests: r });
    expect(r.selectTorrent).toHaveBeenCalledWith(2, 7);
    expect(result.switched_track_ids).toEqual([10, 11]);
    expect(markStale).toHaveBeenCalledWith([10, 11]);
    expect(engine.loads).toHaveLength(loads + 1);
    expect(engine.lastLoad?.opts.startAt).toBe(12);
    const keys = invalidate.mock.calls.map(c => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(albumTorrentsKey(2));
    expect(keys).toContainEqual(['track-sources']);
    expect(sync).toHaveBeenCalledWith('sources');
  });

  it('выбор раздачи без смены треков: на устройстве ничего не трогается; без менеджера — тоже без ошибок', async () => {
    const markStale = vi.fn();
    const none = requests({
      selectTorrent: vi.fn(async () => ({
        matched: 2,
        switched_track_ids: [],
        unmatched: 0,
        image_downloading: false,
      })),
    });
    await selectAlbumTorrent(2, 7, { markStale, queryClient, requests: none });
    expect(markStale).not.toHaveBeenCalled();
    // Офлайн-менеджер не запущен — удаление копий по умолчанию ничего не делает.
    await expect(selectAlbumTorrent(2, 7, { queryClient, requests: requests() })).resolves.toBeTruthy();
  });

  it('сбой удаления копий на устройстве не проваливает выбор раздачи: ошибка сообщается', async () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const boom = new Error('idb closed');
    const result = await selectAlbumTorrent(2, 7, {
      markStale: vi.fn().mockRejectedValue(boom),
      queryClient,
      requests: requests(),
    });
    expect(result.switched_track_ids).toEqual([10, 11]);
    expect(report).toHaveBeenCalledWith(boom);
    expect(sync).toHaveBeenCalledWith('sources');
    vi.unstubAllGlobals();
  });

  it('подтверждение, повторы и magnet: инвалидация и синхронизация', async () => {
    const r = requests();
    await confirmTrackSource(10, 2, 7, { queryClient, requests: r });
    expect(r.confirm).toHaveBeenCalledWith(10, 7);
    expect(await retryTrackSearch(10, 2, { queryClient, requests: r })).toEqual({ queued: true, tracks_reset: 1 });
    expect(await retryAlbumSearch(2, { queryClient, requests: r })).toEqual({ queued: true, tracks_reset: 2 });
    await addAlbumMagnet(2, '  magnet:?xt=urn:btih:x  ', { queryClient, requests: r });
    expect(r.addMagnet).toHaveBeenCalledWith(2, 'magnet:?xt=urn:btih:x');
    expect(sync).toHaveBeenCalledTimes(4);
  });
});

describe('обновление источников по событиям', () => {
  class FakeSocket {
    static last: FakeSocket;
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() {
      FakeSocket.last = this;
    }
    close() {}
  }
  const emit = (event: Record<string, unknown>) =>
    act(() => FakeSocket.last.onmessage?.({ data: JSON.stringify(event) }));
  const getTorrents = vi.mocked(sourcesApi.getAlbumTorrents);

  function Probe({ albumId = 3 }: { albumId?: number }) {
    const q = useAlbumTorrents(albumId);
    useSourcesRefresh(albumId);
    return <p data-testid="count">{q.data?.length ?? 'none'}</p>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetFactories();
    vi.stubGlobal('WebSocket', FakeSocket);
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 3 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 3, artist_id: 1, id: 1 })],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    appData().socket.start();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  afterEach(() => {
    appData().socket.stop();
    vi.useRealTimers();
  });

  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(SOURCES_REFRESH_DEBOUNCE_MS + 10);
    });

  it('10 событий track.status/job.progress этого альбома → один запрос', async () => {
    await screen.findByText('0');
    expect(getTorrents).toHaveBeenCalledTimes(1);
    // Данные «свежие» 30 с, но инвалидация обходит staleTime.
    for (let i = 0; i < 5; i++) {
      emit({ album_id: 3, reason: null, status: 'found', track_id: 1, type: 'track.status' });
      emit({ album_id: 3, done: i, stage: 'searching', total: 10, type: 'job.progress' });
    }
    expect(getTorrents).toHaveBeenCalledTimes(1);
    await settle();
    expect(getTorrents).toHaveBeenCalledTimes(2);
  });

  it('события другого альбома не вызывают запрос', async () => {
    await screen.findByText('0');
    emit({ album_id: 99, reason: null, status: 'found', track_id: 1, type: 'track.status' });
    await settle();
    expect(getTorrents).toHaveBeenCalledTimes(1);
  });
});
