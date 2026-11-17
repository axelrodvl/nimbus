import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db';
import { createSyncEngine, LIVE_FLUSH_MS, type EngineDeps } from '@/lib/sync/engine';
import type { LibraryRows } from '@/lib/db/types';
import { makeAlbum, makeArtist, makeTrack } from '@/test/factories';
import { createLibraryStore } from './library';
import { createLiveStore } from './live';
import { createSelectors } from './selectors';
import { createThrottledSource } from './throttled';

// Пороги — на store и селекторы (не на IndexedDB). Библиотека: 60 000 треков, 5 000 альбомов, 500 артистов.
function bigLibrary(): LibraryRows {
  const rows: LibraryRows = { albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] };
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let a = 1; a <= 500; a++)
    rows.artists.push(makeArtist({ added_at: new Date(base + a * 1000).toISOString(), id: a }));
  for (let al = 1; al <= 5000; al++) {
    rows.albums.push(
      makeAlbum({ added_at: new Date(base + al * 1000).toISOString(), artist_id: 1 + (al % 500), id: al }),
    );
  }
  for (let t = 1; t <= 60_000; t++) {
    const album = 1 + (t % 5000);
    rows.tracks.push(
      makeTrack({
        added_at: new Date(base + t * 1000).toISOString(),
        album_id: album,
        artist_id: 1 + (album % 500),
        id: t,
        position: 1 + Math.floor(t / 5000),
      }),
    );
  }
  return rows;
}

const timed = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
};

describe('производительность store', () => {
  const rows = bigLibrary();

  it('hydrate 60 000 треков < 500 мс', () => {
    const store = createLibraryStore();
    const [, ms] = timed(() => store.getState().hydrate(rows));
    process.stdout.write(`perf: hydrate(60k tracks) = ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(500);
  });

  it('applyBatch на 100 строк при 60 000 в store < 10 мс', () => {
    const store = createLibraryStore();
    store.getState().hydrate(rows);
    const batch = {
      tracks: rows.tracks.slice(0, 100).map(t => ({ ...t, title: `${t.title} (edited)` })),
    };
    const [, ms] = timed(() => store.getState().applyBatch(batch));
    process.stdout.write(`perf: applyBatch(100 rows @60k) = ${ms.toFixed(2)} ms\n`);
    expect(ms).toBeLessThan(10);
  });

  it('libraryTracks() повторно (без изменений) < 1 мс', () => {
    const store = createLibraryStore();
    store.getState().hydrate(rows);
    const selectors = createSelectors();
    const [first, cold] = timed(() => selectors.libraryTracks(store.getState()));
    const [second, warm] = timed(() => selectors.libraryTracks(store.getState()));
    process.stdout.write(`perf: libraryTracks cold = ${cold.toFixed(1)} ms, warm = ${warm.toFixed(3)} ms\n`);
    expect(second).toBe(first);
    expect(first).toHaveLength(60_000);
    expect(warm).toBeLessThan(1);
  });

  it('1000 событий track.status при 60 000 треках: уведомлений не больше числа окон сброса', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // performance.now остаётся настоящим
    try {
      const events = Array.from({ length: 1000 }, (_, i) => ({
        album_id: 1 + ((i + 1) % 5000),
        reason: null,
        status: 'not_found' as const,
        track_id: i + 1,
        type: 'track.status',
      }));
      // «До»: каждое событие — отдельный patchTrack (одно уведомление на событие).
      const old = createLibraryStore();
      old.getState().hydrate(rows);
      let oldNotified = 0;
      old.subscribe(() => (oldNotified += 1));
      const [, oldMs] = timed(() => events.forEach(e => old.getState().patchTrack(e.track_id, { status: e.status })));

      const store = createLibraryStore();
      store.getState().hydrate(rows);
      let notified = 0;
      store.subscribe(() => (notified += 1));
      const db = { patchTracks: vi.fn(() => Promise.resolve()) } as unknown as Db;
      const engine = createSyncEngine({
        api: {} as EngineDeps['api'],
        db,
        live: createLiveStore(),
        store,
        tabs: {} as EngineDeps['tabs'],
      });
      const [, ms] = timed(() => {
        events.forEach(e => engine.handleEvent(e));
        vi.advanceTimersByTime(LIVE_FLUSH_MS);
      });
      process.stdout.write(
        `perf: 1000 track.status @60k: before ${oldMs.toFixed(1)} ms / ${oldNotified} notifications, ` +
          `after ${ms.toFixed(1)} ms / ${notified} notification\n`,
      );
      expect(notified).toBeLessThanOrEqual(1);
      expect(oldNotified).toBe(1000);
      expect(db.patchTracks).toHaveBeenCalledTimes(1);
      expect(ms).toBeLessThan(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('100 patchTrack при 60 000 треках и смонтированной главной (recent + favorites): до / после', () => {
    const run = (throttled: boolean) => {
      const store = createLibraryStore();
      store.getState().hydrate(rows);
      const selectors = createSelectors();
      const home = (s: ReturnType<typeof store.getState>) => [
        selectors.recentlyPlayedAlbums(s, 12),
        selectors.favorites(s),
      ];
      home(store.getState());
      let off: () => void;
      if (throttled) {
        const source = createThrottledSource(store, home, 250);
        off = source.subscribe(() => undefined);
      } else {
        off = store.subscribe(s => void home(s));
      }
      const [, ms] = timed(() => {
        for (let i = 1; i <= 100; i++)
          store.getState().patchTrack(i, { last_played_at: '2026-06-01T00:00:00Z', play_count: i });
      });
      off();
      return ms;
    };
    const before = run(false);
    const after = run(true);
    process.stdout.write(
      `perf: 100 patchTrack @60k with home mounted: before ${before.toFixed(0)} ms, after ${after.toFixed(0)} ms\n`,
    );
    expect(after).toBeLessThan(before);
  });
});
