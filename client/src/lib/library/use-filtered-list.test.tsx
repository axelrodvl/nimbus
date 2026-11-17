import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import type { DownloadedSets } from '@/lib/offline/derive';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { seed } from '@/test/seed';
import { useFilteredLibraryList } from './use-filtered-list';

beforeEach(() => {
  resetFactories();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Blue' })],
    artists: [makeArtist({ id: 1, name: 'Zed' })],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, id: 1, status: 'ready', title: 'Alpha' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 2, status: 'adding', title: 'Beta' }),
    ],
  });
});
afterEach(async () => {
  await resetAppData(false);
});

const none = { downloaded: null, q: '', status: 'all' } as const;
const titles = (r: { items: readonly { title: string }[] }) => r.items.map(t => t.title).sort();

describe('useFilteredLibraryList', () => {
  it('без фильтров отдаёт всё', () => {
    const { result } = renderHook(() => useFilteredLibraryList('tracks', none));
    expect(titles(result.current)).toEqual(['Alpha', 'Beta']);
    expect(result.current.all).toHaveLength(2);
  });

  it('фильтрует по статусу', () => {
    const { result } = renderHook(() => useFilteredLibraryList('tracks', { ...none, status: 'playable' }));
    expect(titles(result.current)).toEqual(['Alpha']);
  });

  it('фильтрует по подстроке, all остаётся полным', () => {
    const { result } = renderHook(() => useFilteredLibraryList('tracks', { ...none, q: 'bet' }));
    expect(titles(result.current)).toEqual(['Beta']);
    expect(result.current.all).toHaveLength(2);
  });

  it('только скачанные', () => {
    const downloaded: DownloadedSets = { albums: new Set(), artists: new Set([1]), tracks: new Set([2]) };
    const tracks = renderHook(() => useFilteredLibraryList('tracks', { ...none, downloaded }));
    expect(titles(tracks.result.current)).toEqual(['Beta']);
    const artists = renderHook(() => useFilteredLibraryList('artists', { ...none, downloaded }));
    expect(artists.result.current.items.map(a => a.name)).toEqual(['Zed']);
    const albums = renderHook(() => useFilteredLibraryList('albums', { ...none, downloaded }));
    expect(albums.result.current.items).toHaveLength(0);
    expect(albums.result.current.all).toHaveLength(1);
  });

  it('пустой результат', () => {
    const { result } = renderHook(() => useFilteredLibraryList('tracks', { ...none, q: 'nope' }));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.all).toHaveLength(2);
  });
});
