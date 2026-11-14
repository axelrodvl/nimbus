import { beforeEach, describe, expect, it } from 'vitest';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import type { LibraryRows } from '@/lib/db/types';
import { createLibraryStore } from './library';
import { createSelectors, normalize } from './selectors';

beforeEach(resetFactories);

function setup(rows: Partial<LibraryRows>) {
  const store = createLibraryStore();
  store.getState().hydrate({ albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [], ...rows });
  return { selectors: createSelectors(), store, s: () => store.getState() };
}

describe('представления', () => {
  it('albumView: имя артиста, число треков и statusCounts по всем трекам альбома', () => {
    const artist = makeArtist({ id: 1, name: 'Radiohead' });
    const album = makeAlbum({ artist_id: 1, id: 1 });
    const { s, selectors } = setup({
      albums: [album],
      artists: [artist],
      tracks: [
        makeTrack({ album_id: 1, id: 1, status: 'ready' }),
        makeTrack({ album_id: 1, id: 2, status: 'ready' }),
        makeTrack({ album_id: 1, id: 3, status: 'found' }),
        makeTrack({ album_id: 1, id: 4, in_library: false, status: 'adding' }),
        makeTrack({ album_id: 1, id: 5, status: 'not_found' }),
      ],
    });
    const v = selectors.albumView(s(), 1);
    expect(v).toMatchObject({ artistName: 'Radiohead', trackCount: 5 });
    expect(v?.statusCounts).toEqual({ adding: 1, found: 1, not_found: 1, ready: 2 });
    expect(selectors.albumView(s(), 404)).toBeUndefined();
  });

  it('trackView: название альбома, имя артиста трека, обложка', () => {
    const { s, selectors } = setup({
      albums: [makeAlbum({ artist_id: 1, cover_url: '/c.jpg', id: 1, title: 'OK Computer' })],
      artists: [makeArtist({ id: 1, name: 'A' }), makeArtist({ id: 2, name: 'Guest' })],
      tracks: [makeTrack({ album_id: 1, artist_id: 2, id: 1 })],
    });
    expect(selectors.trackView(s(), 1)).toMatchObject({
      albumTitle: 'OK Computer',
      artistName: 'Guest',
      coverUrl: '/c.jpg',
    });
    expect(selectors.trackView(s(), 9)).toBeUndefined();
  });

  it('отсутствующие связи дают пустые строки, а не падение', () => {
    const { s, selectors } = setup({ tracks: [makeTrack({ album_id: 5, artist_id: 6, id: 1 })] });
    expect(selectors.trackView(s(), 1)).toMatchObject({ albumTitle: '', artistName: '', coverUrl: null });
  });

  it('artistView: считает альбомы и треки библиотеки (включая треки-гостевые)', () => {
    const { s, selectors } = setup({
      albums: [
        makeAlbum({ artist_id: 1, id: 1, in_library: true }),
        makeAlbum({ artist_id: 1, id: 2, in_library: false }),
        makeAlbum({ artist_id: 1, id: 3, in_library: false }),
        makeAlbum({ artist_id: 2, id: 4, in_library: false }),
      ],
      artists: [makeArtist({ id: 1 }), makeArtist({ id: 2 })],
      tracks: [
        makeTrack({ album_id: 1, artist_id: 1, id: 1 }),
        makeTrack({ album_id: 2, artist_id: 1, id: 2 }),
        makeTrack({ album_id: 3, artist_id: 1, id: 3, in_library: false }),
        // Гость на чужом альбоме: трек артиста 1 в альбоме артиста 2.
        makeTrack({ album_id: 4, artist_id: 1, id: 4 }),
      ],
    });
    // Альбомы в библиотеке: 1 (целиком) и 2 (есть трек); альбом 3 — нет. Треков: 1, 2, 4.
    expect(selectors.artistView(s(), 1)).toMatchObject({ albumCount: 2, trackCount: 3 });
    expect(selectors.artistView(s(), 2)).toMatchObject({ albumCount: 1, trackCount: 1 });
    expect(selectors.artistView(s(), 99)).toBeUndefined();
  });
});

describe('списки библиотеки', () => {
  const rows = () => ({
    albums: [
      makeAlbum({ added_at: '2026-01-01T00:00:00Z', artist_id: 1, id: 1 }),
      makeAlbum({ added_at: '2026-01-02T00:00:00Z', artist_id: 1, id: 2, in_library: false }),
      makeAlbum({ added_at: '2026-01-03T00:00:00Z', artist_id: 2, id: 3, in_library: false }),
      makeAlbum({ added_at: null, artist_id: 2, id: 4, in_library: false }),
    ],
    artists: [
      makeArtist({ added_at: '2026-01-01T00:00:00Z', id: 1 }),
      makeArtist({ added_at: '2026-01-05T00:00:00Z', id: 2 }),
      makeArtist({ id: 3, in_library: false }),
    ],
    tracks: [
      makeTrack({ added_at: '2026-01-01T10:00:00Z', album_id: 1, artist_id: 1, id: 1, status: 'ready' }),
      makeTrack({ added_at: '2026-01-04T10:00:00Z', album_id: 2, artist_id: 1, id: 2, status: 'found' }),
      makeTrack({ added_at: '2026-01-02T10:00:00Z', album_id: 3, artist_id: 2, id: 3, status: 'adding' }),
      makeTrack({ added_at: '2026-01-02T10:00:00Z', album_id: 3, artist_id: 2, id: 4, status: 'ready' }),
      makeTrack({ album_id: 4, artist_id: 2, id: 5, in_library: false }),
    ],
  });

  it('libraryTracks: только библиотека, новые сверху, при равенстве даты — больший id', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.libraryTracks(s()).map(t => t.id)).toEqual([2, 4, 3, 1]);
  });

  it('libraryTracks с фильтром статусов', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.libraryTracks(s(), ['ready']).map(t => t.id)).toEqual([4, 1]);
    expect(selectors.libraryTracks(s(), ['found', 'adding']).map(t => t.id)).toEqual([2, 3]);
  });

  it('libraryAlbums: альбом целиком или с треком в библиотеке; сортировка по самой поздней дате альбома/трека', () => {
    const { s, selectors } = setup(rows());
    // Альбом 2 — по треку (01-04), альбом 3 — по трекам (01-02), альбом 1 — по трекy (01-01 10:00); альбом 4 в библиотеке нет.
    expect(selectors.libraryAlbums(s()).map(a => a.id)).toEqual([2, 3, 1]);
    expect(selectors.libraryAlbums(s(), ['adding']).map(a => a.id)).toEqual([3]);
  });

  it('libraryArtists: артисты библиотеки, новые сверху; фильтр по статусам учитывает альбомы артиста', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.libraryArtists(s()).map(a => a.id)).toEqual([2, 1]);
    expect(selectors.libraryArtists(s(), ['adding']).map(a => a.id)).toEqual([2]);
    expect(selectors.libraryArtists(s(), ['found']).map(a => a.id)).toEqual([1]);
  });

  it('artistAlbums: по году (без года в конце), опционально только библиотека', () => {
    const { s, selectors } = setup({
      albums: [
        makeAlbum({ artist_id: 1, id: 1, in_library: false, year: 2010 }),
        makeAlbum({ artist_id: 1, id: 2, in_library: false, year: null }),
        makeAlbum({ artist_id: 1, id: 3, in_library: true, year: 2001 }),
        makeAlbum({ artist_id: 1, id: 4, in_library: false, year: 2001 }),
      ],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 1, artist_id: 1, id: 1 })],
    });
    expect(selectors.artistAlbums(s(), 1).map(a => a.id)).toEqual([3, 4, 1, 2]);
    expect(selectors.artistAlbums(s(), 1, true).map(a => a.id)).toEqual([3, 1]);
    expect(selectors.artistAlbums(s(), 404)).toEqual([]);
  });

  it('artistTracks: треки альбомов библиотеки артиста — альбомы по году, внутри по порядку; без альбомов вне библиотеки', () => {
    const { s, selectors } = setup({
      albums: [
        makeAlbum({ artist_id: 1, id: 1, in_library: true, year: 2010 }),
        makeAlbum({ artist_id: 1, id: 2, in_library: true, year: 2001 }),
        makeAlbum({ artist_id: 1, id: 3, in_library: false, year: 1999 }),
      ],
      artists: [makeArtist({ id: 1 })],
      tracks: [
        makeTrack({ album_id: 1, artist_id: 1, id: 1, position: 2 }),
        makeTrack({ album_id: 1, artist_id: 1, id: 2, position: 1 }),
        makeTrack({ album_id: 2, artist_id: 1, id: 3, position: 1 }),
        makeTrack({ album_id: 3, artist_id: 1, id: 4, in_library: false, position: 1 }),
      ],
    });
    expect(selectors.artistTracks(s(), 1).map(t => t.id)).toEqual([3, 2, 1]);
    expect(selectors.artistTracks(s(), 1)).toBe(selectors.artistTracks(s(), 1));
    expect(selectors.artistTracks(s(), 404)).toEqual([]);
  });

  it('albumTracks: по disc_no, затем position', () => {
    const { s, selectors } = setup({
      albums: [makeAlbum({ id: 1 })],
      tracks: [
        makeTrack({ album_id: 1, disc_no: 2, id: 1, position: 1 }),
        makeTrack({ album_id: 1, disc_no: 1, id: 2, position: 2 }),
        makeTrack({ album_id: 1, disc_no: 1, id: 3, position: 1 }),
      ],
    });
    expect(selectors.albumTracks(s(), 1).map(t => t.id)).toEqual([3, 2, 1]);
  });

  it('playlistTracks: по id строки, строки без трека пропускаются', () => {
    const { s, selectors } = setup({
      playlistTracks: [
        makePlaylistTrack({ id: 30, playlist_id: 1, track_id: 2 }),
        makePlaylistTrack({ id: 10, playlist_id: 1, track_id: 1 }),
        makePlaylistTrack({ id: 20, playlist_id: 1, track_id: 999 }),
      ],
      playlists: [makePlaylist({ id: 1 })],
      tracks: [makeTrack({ id: 1 }), makeTrack({ id: 2 })],
    });
    expect(selectors.playlistTracks(s(), 1).map(e => [e.id, e.track.id])).toEqual([
      [10, 1],
      [30, 2],
    ]);
  });

  it('recentlyPlayedAlbums: по самому свежему прослушиванию трека, с лимитом', () => {
    const { s, selectors } = setup({
      albums: [makeAlbum({ id: 1 }), makeAlbum({ id: 2 }), makeAlbum({ id: 3 })],
      tracks: [
        makeTrack({ album_id: 1, id: 1, last_played_at: '2026-02-01T00:00:00Z' }),
        makeTrack({ album_id: 1, id: 2, last_played_at: '2026-03-01T00:00:00Z' }),
        makeTrack({ album_id: 2, id: 3, last_played_at: '2026-02-15T00:00:00Z' }),
        makeTrack({ album_id: 3, id: 4, last_played_at: null }),
      ],
    });
    expect(selectors.recentlyPlayedAlbums(s(), 10).map(a => a.id)).toEqual([1, 2]);
    expect(selectors.recentlyPlayedAlbums(s(), 1).map(a => a.id)).toEqual([1]);
  });

  it('favorites: play_count > 0, по убыванию прослушиваний, затем давности; максимум 100', () => {
    const tracks = [
      makeTrack({ id: 1, last_played_at: '2026-01-01T00:00:00Z', play_count: 5 }),
      makeTrack({ id: 2, last_played_at: '2026-02-01T00:00:00Z', play_count: 5 }),
      makeTrack({ id: 3, last_played_at: null, play_count: 9 }),
      makeTrack({ id: 4, play_count: 0 }),
    ];
    const { s, selectors } = setup({ tracks });
    expect(selectors.favorites(s()).map(t => t.id)).toEqual([3, 2, 1]);

    const many = Array.from({ length: 130 }, (_, i) => makeTrack({ id: 1000 + i, play_count: 1 + i }));
    const big = setup({ tracks: many });
    const fav = big.selectors.favorites(big.s());
    expect(fav).toHaveLength(100);
    expect(fav[0]?.id).toBe(1129);
  });
});

describe('searchLocal', () => {
  const rows = () => ({
    albums: [
      makeAlbum({ artist_id: 1, id: 1, title: 'Ёлка на лугу' }),
      makeAlbum({ artist_id: 1, id: 2, in_library: false, title: 'Hidden' }),
    ],
    artists: [makeArtist({ id: 1, name: 'Björk' }), makeArtist({ id: 2, in_library: false, name: 'Björn' })],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, id: 1, title: 'Hyperballad' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 2, title: 'Big Time Sensuality' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 3, title: 'Not In Library', in_library: false }),
    ],
  });

  it('регистр и диакритика не важны', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.searchLocal(s(), 'BJORK', 10).artists.map(a => a.id)).toEqual([1]);
    expect(selectors.searchLocal(s(), 'bjö', 10).artists.map(a => a.id)).toEqual([1]);
  });

  it('«ё» находится по «е»', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.searchLocal(s(), 'елка', 10).albums.map(a => a.id)).toEqual([1]);
    expect(selectors.searchLocal(s(), 'ЁЛКА', 10).albums.map(a => a.id)).toEqual([1]);
  });

  it('ищет только в библиотеке, по подстроке; совпадения с начала — выше', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.searchLocal(s(), 'hid', 10).albums).toEqual([]);
    expect(selectors.searchLocal(s(), 'library', 10).tracks).toEqual([]);
    const res = selectors.searchLocal(s(), 'ti', 10);
    expect(res.tracks.map(t => t.id)).toEqual([2]);
    const st = setup({
      artists: [makeArtist({ id: 1, name: 'The Cure' }), makeArtist({ id: 2, name: 'Cure for Pain' })],
    });
    expect(st.selectors.searchLocal(st.s(), 'cure', 10).artists.map(a => a.id)).toEqual([2, 1]);
  });

  it('пустой запрос и лимит', () => {
    const { s, selectors } = setup(rows());
    expect(selectors.searchLocal(s(), '   ', 10)).toEqual({ albums: [], artists: [], tracks: [] });
    expect(selectors.searchLocal(s(), 'a', 1).tracks).toHaveLength(1);
  });

  it('normalize', () => {
    expect(normalize('  ÅÉÎÕÜ Ёж  ')).toBe('  aeiou еж  ');
  });
});

describe('мемоизация', () => {
  it('те же данные — та же ссылка; изменение — новая', () => {
    const { s, selectors, store } = setup({
      albums: [makeAlbum({ artist_id: 1, id: 1 }), makeAlbum({ artist_id: 1, id: 2 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 1, id: 1 }), makeTrack({ album_id: 2, id: 2 })],
    });
    const list = selectors.libraryTracks(s());
    expect(selectors.libraryTracks(s())).toBe(list);
    const album1 = selectors.albumView(s(), 1);
    const album2 = selectors.albumView(s(), 2);
    expect(selectors.albumView(s(), 1)).toBe(album1);
    expect(selectors.libraryAlbums(s())).toBe(selectors.libraryAlbums(s()));

    store.getState().patchTrack(1, { status: 'adding' });
    expect(selectors.libraryTracks(s())).not.toBe(list);
    expect(selectors.albumView(s(), 1)).not.toBe(album1);
    expect(selectors.albumView(s(), 1)?.statusCounts.adding).toBe(1);
    // Альбом 2 не затронут: та же ссылка.
    expect(selectors.albumView(s(), 2)).toBe(album2);
    expect(selectors.trackView(s(), 2)).toBe(selectors.trackView(s(), 2));
  });

  it('у разных createSelectors кэши независимы', () => {
    const { s } = setup({ tracks: [makeTrack({ id: 1 })] });
    const a = createSelectors();
    const b = createSelectors();
    expect(a.libraryTracks(s())).not.toBe(b.libraryTracks(s()));
  });
});
