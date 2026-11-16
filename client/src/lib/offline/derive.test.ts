import { describe, expect, it } from 'vitest';
import { emptyRows } from '@/lib/db/types';
import { createLibraryStore } from '@/lib/store/library';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack } from '@/test/factories';
import { fileStatus } from '@/test/offline-ui';
import {
  batchProgress,
  decodeSummary,
  doneCount,
  downloadedSets,
  EMPTY_SUMMARY,
  encodeSummary,
  hasPendingDownloads,
  parsePinKey,
  queueStatus,
  remainingUnits,
  sortPins,
  summarize,
  summarizePins,
} from './derive';
import { initialOfflineStatus, type OfflineStatus } from './status';

function library() {
  const store = createLibraryStore();
  store.getState().hydrate({
    ...emptyRows(),
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'A1' }), makeAlbum({ artist_id: 2, id: 2, title: 'A2' })],
    artists: [makeArtist({ id: 1 }), makeArtist({ id: 2 })],
    playlistTracks: [makePlaylistTrack({ id: 1, playlist_id: 7, track_id: 2 })],
    playlists: [makePlaylist({ id: 7, name: 'Road' })],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, id: 1, position: 1, title: 'T1' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 2, position: 2 }),
      makeTrack({ album_id: 2, artist_id: 2, id: 3, position: 1 }),
    ],
  });
  return store.getState();
}

const status = (over: Partial<OfflineStatus> = {}): OfflineStatus => ({ ...initialOfflineStatus(true), ...over });

describe('сводка', () => {
  it('доля альбома не откатывается, когда трек докачан и начался следующий', () => {
    const files = (a: ReturnType<typeof fileStatus>, b: ReturnType<typeof fileStatus>) =>
      status({
        files: new Map([
          [1, a],
          [2, b],
          [3, fileStatus('queued', 0, 0)],
        ]),
      });
    const before = summarize(files(fileStatus('downloading', 99, 100), fileStatus('queued', 0, 0)), [1, 2, 3]);
    const after = summarize(files(fileStatus('done', 100, 100), fileStatus('downloading', 1, 100)), [1, 2, 3]);
    const p = (x: typeof before) => (x.state.kind === 'downloading' ? x.state.progress : -1);
    expect(p(after)).toBeGreaterThanOrEqual(p(before));
  });

  it('считает скачанное, байты и общее состояние', () => {
    const s = status({
      files: new Map([
        [1, fileStatus('done', 100, 100)],
        [2, fileStatus('downloading', 40, 100)],
      ]),
    });
    expect(summarize(s, [1, 2, 3])).toEqual({
      bytes: 140,
      done: 1,
      state: { kind: 'downloading', progress: 0.7 },
      total: 3,
    });
    expect(summarize(s, [])).toEqual({ ...EMPTY_SUMMARY });
  });

  it('кодируется строкой и восстанавливается; процент округляется', () => {
    const x = { bytes: 5, done: 1, state: { kind: 'downloading' as const, progress: 0.456 }, total: 4 };
    expect(encodeSummary(x)).toBe('downloading|46|1|4|5');
    expect(decodeSummary(encodeSummary(x))).toEqual({ ...x, state: { kind: 'downloading', progress: 0.46 } });
    expect(decodeSummary(encodeSummary(EMPTY_SUMMARY))).toEqual(EMPTY_SUMMARY);
    expect(decodeSummary('done|0|2|2|9').state).toEqual({ kind: 'done' });
  });
});

describe('закрепления', () => {
  it('разбирает ключ', () => {
    expect(parsePinKey('album:12')).toEqual({ id: 12, kind: 'album' });
  });

  it('собирает название, состав и размер каждого вида закрепления', () => {
    const lib = library();
    const s = status({
      files: new Map([
        [1, fileStatus('done', 10, 10)],
        [2, fileStatus('done', 20, 20)],
        [3, fileStatus('queued')],
      ]),
      pinTimes: { 'album:1': 100, 'playlist:0': 300, 'playlist:7': 200, 'track:3': 50 },
      pins: new Set(['album:1', 'track:3', 'playlist:7', 'playlist:0', 'album:99', 'playlist:55']),
    });
    const byKey = Object.fromEntries(summarizePins(s, lib, [1, 3]).map(p => [p.key, p]));
    expect(byKey['album:1']).toMatchObject({
      bytes: 30,
      done: 2,
      missing: false,
      state: { kind: 'done' },
      title: 'A1',
      total: 2,
    });
    expect(byKey['track:3']).toMatchObject({ done: 0, state: { kind: 'queued' }, total: 1 });
    expect(byKey['playlist:7']).toMatchObject({ favorites: false, title: 'Road', total: 1, trackIds: [2] });
    expect(byKey['playlist:0']).toMatchObject({ favorites: true, title: null, total: 2, trackIds: [1, 3] });
    expect(byKey['album:99']).toMatchObject({ missing: true, title: null, total: 0 });
    expect(byKey['playlist:55']).toMatchObject({ missing: true });
    expect(byKey['playlist:7']?.pinnedAt).toBe(200);
    expect(Object.values(byKey).every(p => p.failed === 0)).toBe(true);
  });

  it('сортирует по дате (новые первыми) и по размеру', () => {
    const lib = library();
    const s = status({
      files: new Map([
        [1, fileStatus('done', 5, 5)],
        [3, fileStatus('done', 50, 50)],
      ]),
      pinTimes: { 'album:1': 100, 'album:2': 300 },
      pins: new Set(['album:1', 'album:2']),
    });
    const pins = summarizePins(s, lib, []);
    expect(sortPins(pins, 'date').map(p => p.key)).toEqual(['album:2', 'album:1']);
    expect(sortPins(pins, 'size').map(p => p.key)).toEqual(['album:2', 'album:1']);
    expect(sortPins(pins, 'size')[0]?.bytes).toBe(50);
    // Равные значения упорядочены по ключу — порядок стабилен.
    const tie = summarizePins(status({ pins: new Set(['album:2', 'album:1']) }), lib, []);
    expect(sortPins(tie, 'date').map(p => p.key)).toEqual(['album:1', 'album:2']);
  });
});

describe('очередь', () => {
  it('«осталось» и доля пачки', () => {
    const s = status({
      files: new Map([
        [1, fileStatus('queued')],
        [2, fileStatus('downloading', 25, 100)],
        [3, fileStatus('downloading')],
        [4, fileStatus('done', 1, 1)],
        [5, fileStatus('failed')],
      ]),
    });
    expect(remainingUnits(s)).toBeCloseTo(1 + 0.75 + 1);
    expect(batchProgress(1, 4)).toBe(0.75);
    expect(batchProgress(0, 0)).toBe(0);
    expect(batchProgress(9, 4)).toBe(0);
    expect(hasPendingDownloads(status({ queueLength: 1 }))).toBe(true);
    expect(hasPendingDownloads(status({ activeCount: 1 }))).toBe(true);
    expect(hasPendingDownloads(status())).toBe(false);
  });

  it('состояние очереди: пауза, причины остановки, ход, неудачи, покой', () => {
    expect(queueStatus(status({ blocked: 'paused', paused: true }))).toMatchObject({ key: 'paused' });
    expect(queueStatus(status({ blocked: 'paused', paused: true, queueLength: 3 }))).toMatchObject({ key: 'paused' });
    expect(queueStatus(status({ blocked: 'quota', queueLength: 2 }))).toMatchObject({ key: 'quota', queued: 2 });
    expect(queueStatus(status({ blocked: 'offline', activeCount: 1 }))).toMatchObject({ key: 'offline' });
    expect(queueStatus(status({ blocked: 'wifi', queueLength: 1 }))).toMatchObject({ key: 'wifi' });
    expect(queueStatus(status({ blocked: 'unauthorized', queueLength: 1 }))).toMatchObject({ key: 'unauthorized' });
    // Причина без ожидающих загрузок ничего не значит.
    expect(queueStatus(status({ blocked: 'offline' }))).toMatchObject({ key: 'idle' });
    expect(queueStatus(status({ activeCount: 3, queueLength: 41 }))).toMatchObject({
      active: 3,
      key: 'active',
      queued: 41,
    });
    expect(queueStatus(status({ files: new Map([[1, fileStatus('failed')]]) }))).toMatchObject({
      failed: 1,
      key: 'failed',
    });
    expect(queueStatus(status())).toMatchObject({ key: 'idle' });
  });

  it('число скачанных файлов', () => {
    expect(
      doneCount(
        status({
          files: new Map([
            [1, fileStatus('done')],
            [2, fileStatus('queued')],
            [3, fileStatus('done')],
          ]),
        }),
      ),
    ).toBe(2);
  });
});

describe('скачанное целиком', () => {
  it('треки, артисты (хотя бы один трек) и альбомы (все треки)', () => {
    const lib = library();
    const files = new Map([
      [1, fileStatus('done')],
      [2, fileStatus('downloading')],
      [3, fileStatus('done')],
      [99, fileStatus('done')],
    ]);
    const sets = downloadedSets(files, lib);
    expect([...sets.tracks].sort()).toEqual([1, 3]);
    expect([...sets.artists].sort()).toEqual([1, 2]);
    expect([...sets.albums]).toEqual([2]);
  });
});
