import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AcquisitionItem, DownloadsOverview } from '@/lib/api/acquisition';
import { ApiError } from '@/lib/api/errors';
import { createLibraryStore, type LibraryStore } from '@/lib/store/library';
import { item, L, page, summary } from '@/test/acquisition';
import { makeAlbum, makeArtist, makeTrack } from '@/test/factories';
import {
  collectAvailableIds,
  pinAlbum,
  pinAlbums,
  PIN_CONCURRENCY,
  retryAlbums,
  retryFailedJob,
  retryMissing,
  RETRY_CHUNK,
  setAllPaused,
  unpinAlbum,
} from './actions';
import { dropLegacyAlbumStore, flattenPages, LEGACY_ALBUM_STORE_KEY, trimLists, updateAlbumRow } from './cache';
import { downloadsKey, jobsKey, listKey, MAX_REFETCH_PAGES } from './keys';
import {
  attentionCount,
  defaultTab,
  downloadGroups,
  downloadTabs,
  DOWNLOAD_TABS,
  isAlbumTab,
  isDownloadTab,
  isActiveDownload,
  jobKindKey,
  jobTarget,
  nextRetryText,
  outcomeText,
  percent,
  pinStateText,
  reasonText,
  tabCount,
  tabFilter,
} from './model';

const t = (key: Parameters<typeof L>[0], params?: Parameters<typeof L>[1]) => L(key, params);
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('вкладки и счётчики', () => {
  it('вкладка по умолчанию — «Требуют внимания», если не пуста; иначе первая непустая', () => {
    expect(defaultTab(summary({ missing: 1, downloading: 5 }))).toBe('attention');
    expect(defaultTab(summary({ partial: 2 }))).toBe('attention');
    expect(defaultTab(summary({ downloading: 1, available: 4 }))).toBe('downloading');
    expect(defaultTab(summary({ searching: 1, available: 4 }))).toBe('searching');
    expect(defaultTab(summary({ available: 4, downloaded: 9 }))).toBe('available');
    expect(defaultTab(summary({ downloaded: 9 }))).toBe('downloaded');
    expect(defaultTab(summary())).toBe('attention');
    expect(defaultTab(undefined)).toBe('attention');
  });

  it('счётчики берутся из сводки; у «Торренты» и «На этом устройстве» счётчика нет', () => {
    const s = summary({
      available: 4,
      downloaded: 9,
      downloading: 3,
      failed_jobs: 2,
      missing: 5,
      partial: 1,
      searching: 7,
    });
    expect(attentionCount(s)).toBe(6);
    expect(attentionCount(undefined)).toBe(0);
    expect(
      (['attention', 'searching', 'downloading', 'available', 'downloaded', 'torrents', 'device'] as const).map(tab =>
        tabCount(tab, s),
      ),
    ).toEqual([6, 7, 3, 4, 9, undefined, undefined]);
    expect(tabCount('attention', undefined)).toBeUndefined();
  });

  it('загрузка идёт, если состояние downloading или закрепление не завершено; «Доступны» их исключают', () => {
    const queued = item(1, {
      download: { bytes_done: 0, bytes_total: 0, down_bps: 0, peers: 0, pinned: true, state: 'queued' },
      state: 'available',
    });
    const done = item(2, {
      download: { bytes_done: 1, bytes_total: 1, down_bps: 0, peers: 0, pinned: true, state: 'done' },
      state: 'downloaded',
    });
    const plain = item(3, { state: 'available' });
    const running = item(4, { state: 'downloading' });
    expect([queued, done, plain, running].map(isActiveDownload)).toEqual([true, false, false, true]);
    expect([queued, plain, running].filter(tabFilter('downloading')).map(i => i.album.id)).toEqual([1, 4]);
    expect([queued, plain, running].filter(tabFilter('available')).map(i => i.album.id)).toEqual([3]);
    expect([queued, plain].filter(tabFilter('attention'))).toHaveLength(2);
  });
});

describe('тексты', () => {
  it('причина и подсказка — для каждого кода; неизвестный код — без текста', () => {
    for (const code of ['no_torrents', 'dead_torrents', 'no_match', 'search_failed']) {
      const r = reasonText(code, t);
      expect(r?.reason).toBeTruthy();
      expect(r?.hint).toBeTruthy();
      expect(r?.reason).not.toContain('status.reason');
      expect(r?.hint).not.toContain('acq.hint');
    }
    expect(reasonText('no_torrents', t)?.reason).toBe(L('status.reason.no_torrents'));
    expect(reasonText('weird', t)).toBeNull();
    expect(reasonText(null, t)).toBeNull();
    expect(outcomeText('dead_torrents', t)).toBe(L('status.reason.dead_torrents'));
    expect(outcomeText(undefined, t)).toBeNull();
  });

  it('следующий повтор: «скоро», минуты, часы; нет времени или мусор — null', () => {
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(nextRetryText('2026-11-15T10:00:30Z', now, t)).toBe(L('acq.nextRetrySoon'));
    expect(nextRetryText('2026-11-15T09:00:00Z', now, t)).toBe(L('acq.nextRetrySoon'));
    expect(nextRetryText('2026-11-15T10:05:00Z', now, t)).toBe(
      L('acq.nextRetry', { time: L('acq.minutes', { count: 5 }) }),
    );
    expect(nextRetryText('2026-11-15T13:00:00Z', now, t)).toBe(
      L('acq.nextRetry', { time: L('acq.hours', { count: 3 }) }),
    );
    expect(nextRetryText(null, now, t)).toBeNull();
    expect(nextRetryText('not a date', now, t)).toBeNull();
  });

  it('состояния закрепления, проценты, вид задачи и её цель', () => {
    expect(pinStateText('waiting_source', t)).toBe(L('acq.pin.waiting_source'));
    expect(pinStateText('???', t)).toBeNull();
    expect(pinStateText(null, t)).toBeNull();
    expect([percent(50, 200), percent(5, 0), percent(300, 200)]).toEqual([25, 0, 100]);
    expect(jobKindKey('discover_album')).toBe('acq.job.discover_album');
    expect(jobKindKey('mystery')).toBeNull();
    expect(jobTarget({ album_id: 7 })).toEqual({ id: 7, label: 'acq.job.album', to: '/album/7' });
    expect(jobTarget({ artist_id: 3 })).toEqual({ id: 3, label: 'acq.job.artist', to: '/artist/3' });
    expect(jobTarget({ x: 1 })).toBeNull();
    expect(jobTarget(null)).toBeNull();
  });
});

describe('кэш списков', () => {
  it('flattenPages убирает повторы между страницами (перезапрос посреди прокрутки)', () => {
    const data = {
      pageParams: [null, 'c1'],
      pages: [page([item(1), item(2)], 'c1'), page([item(2), item(3)])],
    };
    expect(flattenPages(data).map(i => i.album.id)).toEqual([1, 2, 3]);
    expect(flattenPages(undefined)).toEqual([]);
  });

  it('trimLists оставляет не больше MAX_REFETCH_PAGES страниц', () => {
    const qc = client();
    const pages = Array.from({ length: MAX_REFETCH_PAGES + 4 }, (_, i) => page([item(i + 1)], `c${i}`));
    qc.setQueryData(listKey(['missing']), { pageParams: pages.map((_, i) => (i ? `c${i - 1}` : null)), pages });
    trimLists(qc);
    const data = qc.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(listKey(['missing']));
    expect([data?.pages.length, data?.pageParams.length]).toEqual([MAX_REFETCH_PAGES, MAX_REFETCH_PAGES]);
  });

  it('updateAlbumRow меняет строку во всех списках; чужие строки не трогает', () => {
    const qc = client();
    qc.setQueryData(listKey(['available']), { pageParams: [null], pages: [page([item(1), item(2)])] });
    qc.setQueryData(listKey(['missing']), { pageParams: [null], pages: [page([item(1)])] });
    updateAlbumRow(qc, 1, i => ({ ...i, state: 'downloaded' }));
    const list = qc.getQueryData<{ pages: { items: AcquisitionItem[] }[] }>(listKey(['available']));
    expect(list?.pages[0]?.items.map(i => i.state)).toEqual(['downloaded', 'missing']);
    const other = qc.getQueryData<{ pages: { items: AcquisitionItem[] }[] }>(listKey(['missing']));
    expect(other?.pages[0]?.items[0]?.state).toBe('downloaded');
  });

  it('старый кэш состояний альбомов в localStorage удаляется', () => {
    localStorage.setItem(LEGACY_ALBUM_STORE_KEY, '{"1":{}}');
    dropLegacyAlbumStore();
    expect(localStorage.getItem(LEGACY_ALBUM_STORE_KEY)).toBeNull();
  });
});

describe('повтор поиска', () => {
  it('для всех: scope=missing и reset_dead; для выбранных: scope=albums + id', async () => {
    const retry = vi.fn().mockResolvedValue(4);
    const qc = client();
    expect(await retryMissing({ resetDead: true }, { queryClient: qc, requests: { retry } })).toBe(4);
    expect(retry).toHaveBeenLastCalledWith({ reset_dead: true, scope: 'missing' });
    await retryAlbums([3, 5], { resetDead: false }, { queryClient: qc, requests: { retry } });
    expect(retry).toHaveBeenLastCalledWith({ album_ids: [3, 5], reset_dead: false, scope: 'albums' });
  });

  it('больше 5000 альбомов уходят несколькими запросами, результат суммируется', async () => {
    const retry = vi.fn().mockImplementation(async (b: { album_ids: number[] }) => b.album_ids.length);
    const ids = Array.from({ length: RETRY_CHUNK + 1 }, (_, i) => i + 1);
    const queued = await retryAlbums(ids, { resetDead: false }, { queryClient: client(), requests: { retry } });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(queued).toBe(RETRY_CHUNK + 1);
  });
});

describe('закрепление альбома', () => {
  const row1 = (qc: QueryClient) =>
    qc.getQueryData<{ pages: { items: AcquisitionItem[] }[] }>(listKey(['available']))?.pages[0]?.items[0];
  const seedRow = (qc: QueryClient, row = item(1, { state: 'available' })) => {
    qc.setQueryData(listKey(['available']), { pageParams: [null], pages: [page([row])] });
  };
  /** Альбом 1: трек 11 найден, 12 скачан и закреплён «упал», 13 не найден, 14 каталожный (не в библиотеке). */
  const seedLibrary = (): LibraryStore => {
    const lib = createLibraryStore();
    lib.getState().hydrate({
      albums: [makeAlbum({ artist_id: 1, id: 1 })],
      artists: [makeArtist({ id: 1 })],
      playlistTracks: [],
      playlists: [],
      tracks: [
        makeTrack({ album_id: 1, id: 11, status: 'found' }),
        makeTrack({ album_id: 1, id: 12, pin: 'failed', pin_error: 'stalled', status: 'ready' }),
        makeTrack({ album_id: 1, id: 13, status: 'not_found' }),
        makeTrack({ album_id: 1, id: 14, in_library: false, status: 'found' }),
      ],
    });
    return lib;
  };
  const pins = (lib: LibraryStore) =>
    [11, 12, 13, 14].map(id => {
      const t = lib.getState().tracks.get(id);
      return [t?.pin ?? null, t?.pin_error ?? null, t?.status];
    });

  it('оптимистично: строка сразу «в очереди»; при ошибке откат и исключение', async () => {
    const qc = client();
    seedRow(qc);
    let release!: () => void;
    const pin = vi.fn().mockReturnValue(new Promise<void>(r => (release = r)));
    const p = pinAlbum(1, { library: seedLibrary(), queryClient: qc, requests: { pinAlbum: pin } });
    expect(row1(qc)?.download).toMatchObject({ pinned: true, state: 'queued' });
    release();
    await p;
    expect(pin).toHaveBeenCalledWith(1);

    const failing = client();
    seedRow(failing);
    const err = new ApiError(500, 'internal', 'boom');
    await expect(
      pinAlbum(1, {
        library: seedLibrary(),
        queryClient: failing,
        requests: { pinAlbum: vi.fn().mockRejectedValue(err) },
      }),
    ).rejects.toBe(err);
    expect(row1(failing)?.download).toBeNull();
  });

  it('закрепление сразу видно в store (как ставит сервер); ошибка — откат', async () => {
    const lib = seedLibrary();
    let release!: () => void;
    const p = pinAlbum(1, {
      library: lib,
      queryClient: client(),
      requests: { pinAlbum: vi.fn().mockReturnValue(new Promise<void>(r => (release = r))) },
    });
    expect(pins(lib)).toEqual([
      ['queued', null, 'found'],
      ['queued', null, 'ready'],
      ['waiting_source', null, 'not_found'],
      [null, null, 'found'],
    ]);
    release();
    await p;

    const failing = seedLibrary();
    const before = pins(failing);
    await expect(
      pinAlbum(1, {
        library: failing,
        queryClient: client(),
        requests: { pinAlbum: vi.fn().mockRejectedValue(new Error('x')) },
      }),
    ).rejects.toThrow('x');
    expect(pins(failing)).toEqual(before);
  });

  it('откат не затирает то, что пришло за время запроса', async () => {
    const lib = seedLibrary();
    let fail!: (e: Error) => void;
    const p = pinAlbum(1, {
      library: lib,
      queryClient: client(),
      requests: { pinAlbum: vi.fn().mockReturnValue(new Promise<void>((_, r) => (fail = r))) },
    });
    // дельта: трек 11 уже качается, у 13 сменился статус
    lib.getState().patchTracks(
      new Map([
        [11, { pin: 'downloading' as const }],
        [13, { status: 'found' as const }],
      ]),
    );
    fail(new Error('x'));
    await expect(p).rejects.toThrow('x');
    expect(pins(lib)).toEqual([
      ['downloading', null, 'found'],
      ['failed', 'stalled', 'ready'],
      [null, null, 'found'],
      [null, null, 'found'],
    ]);
  });

  it('снятие закрепления: deleteFiles возвращает «скачан» в «доступен»; ошибка — откат', async () => {
    const qc = client();
    const row = item(1, {
      download: { bytes_done: 5, bytes_total: 5, down_bps: 0, peers: 0, pinned: true, state: 'done' },
      state: 'downloaded',
    });
    seedRow(qc, row);
    const lib = seedLibrary();
    const unpin = vi.fn().mockResolvedValue(undefined);
    await unpinAlbum(1, { deleteFiles: true }, { library: lib, queryClient: qc, requests: { unpinAlbum: unpin } });
    expect(unpin).toHaveBeenCalledWith(1, true);
    expect(row1(qc)).toMatchObject({ download: { pinned: false }, state: 'available' });
    // закрепление снято; статусы файлов не тронуты — их принесёт дельта (сервер удаляет не всё)
    expect(pins(lib)).toEqual([
      [null, null, 'found'],
      [null, null, 'ready'],
      [null, null, 'not_found'],
      [null, null, 'found'],
    ]);

    const failing = client();
    seedRow(failing, row);
    const failingLib = seedLibrary();
    const before = pins(failingLib);
    await expect(
      unpinAlbum(
        1,
        { deleteFiles: false },
        {
          library: failingLib,
          queryClient: failing,
          requests: { unpinAlbum: vi.fn().mockRejectedValue(new Error('x')) },
        },
      ),
    ).rejects.toThrow('x');
    expect(row1(failing)).toMatchObject({ download: { pinned: true }, state: 'downloaded' });
    expect(pins(failingLib)).toEqual(before);
  });
});

describe('пауза и задачи', () => {
  it('пауза всех: состояние в кэше — из ответа сервера', async () => {
    const qc = client();
    qc.setQueryData<DownloadsOverview>(downloadsKey, {
      down_bps: 0,
      paused: false,
      queue: { downloading: 0, failed: 0, queued: 0, waiting_source: 0 },
      torrents: [],
      up_bps: 0,
    });
    // Сервер ответил «на паузе», даже если просили иначе — верим ответу.
    expect(
      await setAllPaused(false, { queryClient: qc, requests: { setPausedAll: vi.fn().mockResolvedValue(true) } }),
    ).toBe(true);
    expect(qc.getQueryData<DownloadsOverview>(downloadsKey)?.paused).toBe(true);
  });

  it('повтор задачи убирает строку; 409 остаётся ошибкой, строка на месте', async () => {
    const qc = client();
    qc.setQueryData(jobsKey, { counts: {}, jobs: [{ id: 1 }, { id: 2 }] });
    await retryFailedJob(1, { queryClient: qc, requests: { retryJob: vi.fn().mockResolvedValue({}) } });
    expect(qc.getQueryData<{ jobs: { id: number }[] }>(jobsKey)?.jobs.map(j => j.id)).toEqual([2]);
    const conflict = new ApiError(409, 'duplicate', 'dup');
    await expect(
      retryFailedJob(2, { queryClient: qc, requests: { retryJob: vi.fn().mockRejectedValue(conflict) } }),
    ).rejects.toBe(conflict);
    expect(qc.getQueryData<{ jobs: { id: number }[] }>(jobsKey)?.jobs.map(j => j.id)).toEqual([2]);
  });
});

describe('массовое закрепление', () => {
  it('collectAvailableIds листает все страницы и пропускает уже закреплённые', async () => {
    const queued = item(2, {
      download: { bytes_done: 0, bytes_total: 0, down_bps: 0, peers: 0, pinned: true, state: 'queued' },
      state: 'available',
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([item(1, { state: 'available' }), queued], 'c1'))
      .mockResolvedValueOnce(page([item(3, { state: 'available' })]));
    expect(await collectAvailableIds({ queryClient: client(), requests: { list } })).toEqual([1, 3]);
    expect(list.mock.calls.map(c => c[0].cursor)).toEqual([null, 'c1']);
  });

  it('параллельность не больше 4, прогресс по каждому, сбой одного не останавливает остальных', async () => {
    let running = 0;
    let peak = 0;
    const pin = vi.fn().mockImplementation(async (id: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 1));
      running--;
      if (id === 3) throw new Error('nope');
    });
    const progress = vi.fn();
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const result = await pinAlbums(ids, { queryClient: client(), requests: { pinAlbum: pin } }, progress);
    expect(result).toEqual({ done: 12, failed: 1 });
    expect(peak).toBeLessThanOrEqual(PIN_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(progress).toHaveBeenCalledTimes(12);
    expect(progress).toHaveBeenLastCalledWith(12, 12);
  });

  it('пустой список — без запросов', async () => {
    const pin = vi.fn();
    expect(await pinAlbums([], { queryClient: client(), requests: { pinAlbum: pin } })).toEqual({ done: 0, failed: 0 });
    expect(pin).not.toHaveBeenCalled();
  });
});

describe('разделы «Загрузок»', () => {
  it('сгруппированы по месту: поиск, сервер, устройство; без поддержки офлайна группы «устройство» нет', () => {
    expect(downloadGroups(true).map(g => [g.id, g.tabs])).toEqual([
      ['search', ['attention', 'searching', 'available']],
      ['server', ['downloading', 'downloaded', 'torrents']],
      ['device', ['device']],
    ]);
    expect(downloadGroups(false).map(g => g.id)).toEqual(['search', 'server']);
    expect(downloadTabs(true)).toEqual([...DOWNLOAD_TABS]);
    expect(downloadTabs(false)).not.toContain('device');
    expect(isDownloadTab('jobs')).toBe(false);
    expect(isAlbumTab('device')).toBe(false);
    expect(isAlbumTab('torrents')).toBe(false);
    expect(isAlbumTab('attention')).toBe(true);
  });
});
