import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAlbum,
  makeArtist,
  makeLibrary,
  makePlaylist,
  makePlaylistTrack,
  makeTrack,
  resetFactories,
} from '@/test/factories';
import { createLibraryStore } from './library';

beforeEach(resetFactories);

const withLibrary = () => {
  const store = createLibraryStore();
  const rows = makeLibrary({ albumsPerArtist: 2, artists: 2, tracksPerAlbum: 3 });
  store.getState().hydrate(rows);
  return { rows, store };
};

describe('hydrate / replaceAll / reset', () => {
  it('hydrate строит коллекции и индексы и поднимает hydrated', () => {
    const { store } = withLibrary();
    const s = store.getState();
    expect(s.hydrated).toBe(true);
    expect(s.artists.size).toBe(2);
    expect(s.albumsByArtist.get(1)).toEqual([1, 2]);
    expect(s.tracksByAlbum.get(1)).toEqual([1, 2, 3]);
    expect(s.tracksByArtist.get(2)).toHaveLength(6);
    expect(s.version).toBe(1);
  });

  it('replaceAll заменяет всё и пересобирает индексы', () => {
    const { store } = withLibrary();
    store
      .getState()
      .replaceAll({ albums: [], artists: [makeArtist({ id: 50 })], playlistTracks: [], playlists: [], tracks: [] });
    const s = store.getState();
    expect([...s.artists.keys()]).toEqual([50]);
    expect(s.tracks.size).toBe(0);
    expect(s.tracksByAlbum.size).toBe(0);
    expect(s.version).toBe(2);
  });

  it('reset возвращает пустое состояние, version продолжает расти', () => {
    const { store } = withLibrary();
    store.getState().reset();
    expect(store.getState().hydrated).toBe(false);
    expect(store.getState().tracks.size).toBe(0);
    expect(store.getState().version).toBe(2);
  });
});

describe('applyBatch', () => {
  it('вставка обновляет коллекции и индексы', () => {
    const { store } = withLibrary();
    const artist = makeArtist({ id: 10 });
    const album = makeAlbum({ artist_id: 10, id: 10 });
    const track = makeTrack({ album_id: 10, artist_id: 10, id: 100 });
    store.getState().applyBatch({ albums: [album], artists: [artist], tracks: [track] });
    const s = store.getState();
    expect(s.albumsByArtist.get(10)).toEqual([10]);
    expect(s.tracksByAlbum.get(10)).toEqual([100]);
    expect(s.tracksByArtist.get(10)).toEqual([100]);
  });

  it('перемещение трека между альбомами и исполнителями обновляет оба индекса', () => {
    const { rows, store } = withLibrary();
    const moved = { ...(rows.tracks[0] as (typeof rows.tracks)[0]), album_id: 4, artist_id: 2 };
    store.getState().applyBatch({ tracks: [moved] });
    const s = store.getState();
    expect(s.tracksByAlbum.get(1)).toEqual([2, 3]);
    expect(s.tracksByAlbum.get(4)).toContain(1);
    expect(s.tracksByArtist.get(1)).not.toContain(1);
    expect(s.tracksByArtist.get(2)).toContain(1);
  });

  it('перемещение альбома к другому артисту и строки плейлиста — в другой плейлист', () => {
    const { rows, store } = withLibrary();
    store.getState().applyBatch({
      albums: [{ ...(rows.albums[0] as (typeof rows.albums)[0]), artist_id: 2 }],
      playlistTracks: [makePlaylistTrack({ id: 900, playlist_id: 7, track_id: 1 })],
      playlists: [makePlaylist({ id: 7 }), makePlaylist({ id: 8 })],
    });
    store.getState().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 900, playlist_id: 8, track_id: 1 })] });
    const s = store.getState();
    expect(s.albumsByArtist.get(1)).toEqual([2]);
    expect(s.albumsByArtist.get(2)).toContain(1);
    expect(s.tracksByPlaylist.get(7)).toBeUndefined();
    expect(s.tracksByPlaylist.get(8)).toEqual([900]);
  });

  it('удаления всех сущностей чистят индексы; каскад приходит явными надгробиями', () => {
    const { store } = withLibrary();
    store.getState().applyBatch({
      playlistTracks: [makePlaylistTrack({ id: 900, playlist_id: 7, track_id: 1 })],
      playlists: [makePlaylist({ id: 7 })],
    });
    // Удалён альбом 1: сервер присылает надгробия альбома и его треков.
    store.getState().applyBatch({
      deleted: [
        { entity: 'album', id: 1 },
        { entity: 'track', id: 1 },
        { entity: 'track', id: 2 },
        { entity: 'track', id: 3 },
        { entity: 'playlist_track', id: 900 },
        { entity: 'playlist', id: 7 },
        { entity: 'artist', id: 2 },
        { entity: 'unknown', id: 1 },
        { entity: 'track', id: 12345 },
      ],
    });
    const s = store.getState();
    expect(s.albums.has(1)).toBe(false);
    expect(s.albumsByArtist.get(1)).toEqual([2]);
    expect(s.tracksByAlbum.has(1)).toBe(false);
    expect(s.tracksByArtist.get(1)).toEqual([4, 5, 6]); // остались треки альбома 2
    expect(s.tracksByPlaylist.has(7)).toBe(false);
    expect(s.playlists.size).toBe(0);
    expect(s.artists.has(2)).toBe(false);
  });

  it('version растёт на каждое применение, пустая пачка состояние не трогает', () => {
    const { store } = withLibrary();
    const before = store.getState();
    store.getState().applyBatch({});
    expect(store.getState()).toBe(before);
    store.getState().applyBatch({ artists: [makeArtist({ id: 77 })] });
    expect(store.getState().version).toBe(before.version + 1);
  });

  it('одно применение — одно уведомление подписчиков', () => {
    const { store } = withLibrary();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().applyBatch({
      albums: [makeAlbum({ id: 20 })],
      artists: [makeArtist({ id: 20 })],
      deleted: [{ entity: 'track', id: 1 }],
      tracks: [makeTrack({ id: 200 }), makeTrack({ id: 201 })],
    });
    expect(listener).toHaveBeenCalledOnce();
    store.getState().patchTrack(2, { status: 'adding' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('копируются только изменившиеся коллекции', () => {
    const { store } = withLibrary();
    const before = store.getState();
    store.getState().applyBatch({ tracks: [makeTrack({ album_id: 1, artist_id: 1, id: 500 })] });
    const after = store.getState();
    expect(after.tracks).not.toBe(before.tracks);
    expect(after.artists).toBe(before.artists);
    expect(after.albums).toBe(before.albums);
    expect(after.playlists).toBe(before.playlists);
    expect(after.albumsByArtist).toBe(before.albumsByArtist);
    // Индекс альбома 1 изменился, индекс альбома 2 — тот же массив.
    expect(after.tracksByAlbum.get(1)).not.toBe(before.tracksByAlbum.get(1));
    expect(after.tracksByAlbum.get(2)).toBe(before.tracksByAlbum.get(2));
  });

  it('повторное применение той же пачки не меняет данные (идемпотентность)', () => {
    const { rows, store } = withLibrary();
    const batch = {
      deleted: [{ entity: 'track', id: 3 }],
      tracks: [
        { ...(rows.tracks[0] as (typeof rows.tracks)[0]), title: 'New' },
        makeTrack({ album_id: 2, artist_id: 1, id: 300 }),
      ],
    };
    store.getState().applyBatch(batch);
    const snap = () => {
      const s = store.getState();
      const plain = (m: { entries(): IterableIterator<[number, unknown]> }) =>
        [...m.entries()].sort((a, b) => a[0] - b[0]);
      return JSON.stringify([plain(s.tracks), plain(s.tracksByAlbum), plain(s.tracksByArtist)]);
    };
    const once = snap();
    store.getState().applyBatch(batch);
    expect(snap()).toBe(once);
  });
});

describe('patchTrack', () => {
  it('меняет поля трека, не трогая индексы', () => {
    const { store } = withLibrary();
    const index = store.getState().tracksByAlbum;
    store.getState().patchTrack(1, { status: 'not_found', status_reason: 'nothing' });
    expect(store.getState().tracks.get(1)).toMatchObject({ status: 'not_found', status_reason: 'nothing' });
    expect(store.getState().tracksByAlbum).toBe(index);
  });

  it('неизвестный трек игнорируется без обновления', () => {
    const { store } = withLibrary();
    const before = store.getState();
    store.getState().patchTrack(9999, { status: 'ready' });
    expect(store.getState()).toBe(before);
  });
});

describe('patchTracks', () => {
  it('пачка — одно обновление; отсутствующие id пропускаются', () => {
    const { store } = withLibrary();
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.getState().patchTracks(
      new Map([
        [1, { status: 'ready' as const }],
        [2, { status: 'adding' as const }],
        [9999, { status: 'ready' as const }],
      ]),
    );
    expect(notified).toBe(1);
    expect(store.getState().tracks.get(1)?.status).toBe('ready');
    expect(store.getState().tracks.get(2)?.status).toBe('adding');
    expect(store.getState().tracks.has(9999)).toBe(false);
  });

  it('пачка из одних отсутствующих id не обновляет состояние', () => {
    const { store } = withLibrary();
    const before = store.getState();
    store.getState().patchTracks(new Map([[9999, { status: 'ready' as const }]]));
    expect(store.getState()).toBe(before);
  });
});
