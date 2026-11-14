import { describe, expect, it } from 'vitest';
import type { LibraryRows } from '@/lib/db/types';
import { makeAlbum, makeArtist, makeTrack } from '@/test/factories';
import { createLibraryStore } from './library';
import { createSelectors } from './selectors';

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
});
