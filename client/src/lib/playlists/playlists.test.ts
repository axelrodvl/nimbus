import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { parsePlaylistRef } from '@/lib/api/playlists';
import { appData } from '@/lib/app-data';
import { TEMP_ID_BASE } from '@/lib/store/library';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import { seed } from '@/test/seed';
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  isInPlaylist,
  removeTrackFromPlaylist,
  type PlaylistRequests,
} from './actions';

const COVER = 'https://coverartarchive.org/release-group/abc/front';

beforeEach(() => {
  resetFactories();
  seed({
    albums: [makeAlbum({ artist_id: 1, cover_url: null, id: 1 }), makeAlbum({ artist_id: 1, cover_url: COVER, id: 2 })],
    artists: [makeArtist({ id: 1 })],
    playlistTracks: [
      makePlaylistTrack({ id: 1, playlist_id: 1, track_id: 10 }),
      makePlaylistTrack({ id: 2, playlist_id: 1, track_id: 20 }),
      makePlaylistTrack({ id: 3, playlist_id: 2, track_id: 999 }),
    ],
    playlists: [
      makePlaylist({ id: 1, last_used_at: '2026-01-01T00:00:00Z', name: 'Old' }),
      makePlaylist({ id: 2, last_used_at: '2026-03-01T00:00:00Z', name: 'Fresh' }),
      makePlaylist({ id: 3, last_used_at: '2026-02-01T00:00:00Z', name: 'Mid' }),
    ],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, duration_ms: 1000, id: 10 }),
      makeTrack({ album_id: 2, artist_id: 1, duration_ms: 2000, id: 20 }),
      makeTrack({ album_id: 2, artist_id: 1, duration_ms: 4000, id: 30 }),
    ],
  });
});

const state = () => appData().library.getState();
const cards = () => appData().selectors.playlistCards(state());
const rowsOf = (playlistId: number) =>
  (state().tracksByPlaylist.get(playlistId) ?? []).map(id => state().playlistTracks.get(id)!.track_id);

function fakeRequests(over: Partial<PlaylistRequests> = {}): PlaylistRequests {
  return {
    add: vi.fn(async () => undefined),
    create: vi.fn(async (name: string) => ({ created_at: '2026-06-01T00:00:00Z', id: 77, name })),
    delete: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...over,
  };
}

describe('parsePlaylistRef', () => {
  it('число, favorites; остальное — null', () => {
    expect(parsePlaylistRef('12')).toBe(12);
    expect(parsePlaylistRef('favorites')).toBe('favorites');
    for (const bad of [undefined, '', 'abc', '-1', '1.5', '1e3', '99999999999999999999']) {
      expect(parsePlaylistRef(bad)).toBeNull();
    }
  });
});

describe('селекторы плейлистов', () => {
  it('порядок: пользовательские по last_used_at (свежие первыми); «Избранного» без прослушиваний нет', () => {
    expect(cards().map(c => c.id)).toEqual([2, 3, 1]);
    expect(cards().some(c => c.kind === 'favorites')).toBe(false);
  });

  it('«Избранное» первым, когда есть прослушивания, и пересчитывается после прослушивания', () => {
    state().patchTrack(20, { play_count: 3 });
    expect(cards().map(c => c.id)).toEqual(['favorites', 2, 3, 1]);
    expect(cards()[0]).toMatchObject({ kind: 'favorites', trackCount: 1 });
    state().patchTrack(30, { play_count: 1 });
    expect(cards()[0]?.trackCount).toBe(2);
  });

  it('оптимистичный счётчик заменяется серверным, а не суммируется', () => {
    state().patchTrack(20, { play_count: 6 });
    // Дельта сервера: настоящее значение 5 (оптимистичное было 6).
    state().applyBatch({ tracks: [{ ...state().tracks.get(20)!, play_count: 5 }] });
    expect(state().tracks.get(20)?.play_count).toBe(5);
    expect(
      appData()
        .selectors.favorites(state())
        .map(t => t.id),
    ).toEqual([20]);
  });

  it('число треков — только имеющиеся в store; обложка — первого трека с обложкой; длительность — сумма', () => {
    const one = cards().find(c => c.id === 1)!;
    expect(one).toMatchObject({ coverUrl: COVER, durationMs: 3000, trackCount: 2 });
    // Строка плейлиста 2 ссылается на трек 999, которого нет, — он не считается.
    expect(cards().find(c => c.id === 2)).toMatchObject({ coverUrl: null, trackCount: 0 });
  });

  it('playlistCard: пустое «Избранное» существует и стабильно (та же ссылка)', () => {
    const { selectors } = appData();
    const a = selectors.playlistCard(state(), 'favorites');
    expect(a).toMatchObject({ kind: 'favorites', trackCount: 0 });
    expect(selectors.playlistCard(state(), 'favorites')).toBe(a);
    expect(selectors.playlistCard(state(), 12345)).toBeUndefined();
    expect(selectors.playlistCard(state(), 1)?.name).toBe('Old');
  });

  it('playlistsOfTrack: где уже есть трек', () => {
    expect([...appData().selectors.playlistsOfTrack(state(), 10)]).toEqual([1]);
    expect(appData().selectors.playlistsOfTrack(state(), 30).size).toBe(0);
  });
});

// Фабрика строит дату из id, а временные id огромны — строка собирается вручную.
const tempRow = (n: number, playlist_id: number, track_id: number) => ({
  added_at: '2026-06-01T00:00:00Z',
  id: TEMP_ID_BASE + n,
  playlist_id,
  track_id,
});

describe('store: временные строки', () => {
  it('настоящая строка из дельты заменяет временную для той же пары', () => {
    state().applyBatch({ playlistTracks: [tempRow(1, 3, 30)] });
    expect(rowsOf(3)).toEqual([30]);
    state().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 50, playlist_id: 3, track_id: 30 })] });
    expect(rowsOf(3)).toEqual([30]);
    expect(state().tracksByPlaylist.get(3)).toEqual([50]);
  });

  it('временная строка другого трека остаётся', () => {
    state().applyBatch({ playlistTracks: [tempRow(1, 3, 30)] });
    state().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 50, playlist_id: 3, track_id: 10 })] });
    expect(rowsOf(3).sort()).toEqual([10, 30]);
  });
});

describe('createPlaylist', () => {
  it('до ответа store не меняется; после — плейлист вставлен, возвращается id', async () => {
    let resolve!: (v: { created_at: string; id: number; name: string }) => void;
    const requests = fakeRequests({ create: () => new Promise(r => (resolve = r)) });
    const promise = createPlaylist('New', requests);
    expect(state().playlists.size).toBe(3);
    resolve({ created_at: '2026-06-01T00:00:00Z', id: 77, name: 'New' });
    expect(await promise).toBe(77);
    expect(state().playlists.get(77)).toMatchObject({ last_used_at: '2026-06-01T00:00:00Z', name: 'New' });
    expect(cards()[0]?.id).toBe(77);
  });

  it('ошибка сервера: store не изменился, ApiError', async () => {
    const requests = fakeRequests({ create: vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'boom')) });
    await expect(createPlaylist('X', requests)).rejects.toMatchObject({ status: 500 });
    expect(state().playlists.size).toBe(3);
  });

  it('без сети — offline без запроса', async () => {
    const requests = fakeRequests();
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(createPlaylist('X', requests)).rejects.toMatchObject({ code: 'offline', status: 0 });
    expect(requests.create).not.toHaveBeenCalled();
    expect(state().playlists.size).toBe(3);
  });
});

describe('deletePlaylist', () => {
  it('оптимистично убирает плейлист и его состав', async () => {
    const requests = fakeRequests();
    await deletePlaylist(1, requests);
    expect(requests.delete).toHaveBeenCalledWith(1);
    expect(state().playlists.has(1)).toBe(false);
    expect(rowsOf(1)).toEqual([]);
  });

  it('500: плейлист и состав возвращаются', async () => {
    const requests = fakeRequests({ delete: vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'boom')) });
    await expect(deletePlaylist(1, requests)).rejects.toMatchObject({ status: 500 });
    expect(state().playlists.get(1)?.name).toBe('Old');
    expect(rowsOf(1)).toEqual([10, 20]);
  });
});

describe('addTrackToPlaylist', () => {
  it('оптимистично: трек в плейлисте и last_used_at обновлён (плейлист поднимается)', async () => {
    const requests = fakeRequests();
    expect(await addTrackToPlaylist(1, 30, requests)).toBe('added');
    expect(requests.add).toHaveBeenCalledWith(1, 30);
    expect(rowsOf(1)).toEqual([10, 20, 30]);
    expect(isInPlaylist(1, 30)).toBe(true);
    expect(cards()[0]?.id).toBe(1);
  });

  it('уже в плейлисте: запроса нет, результат exists', async () => {
    const requests = fakeRequests();
    expect(await addTrackToPlaylist(1, 10, requests)).toBe('exists');
    expect(requests.add).not.toHaveBeenCalled();
    expect(rowsOf(1)).toEqual([10, 20]);
  });

  it('двойной вызов подряд не создаёт дубль', async () => {
    const requests = fakeRequests();
    await addTrackToPlaylist(1, 30, requests);
    expect(await addTrackToPlaylist(1, 30, requests)).toBe('exists');
    expect(requests.add).toHaveBeenCalledOnce();
  });

  it('500: временная строка и last_used_at откатываются', async () => {
    const requests = fakeRequests({ add: vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'boom')) });
    await expect(addTrackToPlaylist(1, 30, requests)).rejects.toMatchObject({ status: 500 });
    expect(rowsOf(1)).toEqual([10, 20]);
    expect(state().playlists.get(1)?.last_used_at).toBe('2026-01-01T00:00:00Z');
  });

  it('дельта с настоящей строкой после успеха: трек в плейлисте один раз', async () => {
    await addTrackToPlaylist(1, 30, fakeRequests());
    state().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 40, playlist_id: 1, track_id: 30 })] });
    expect(rowsOf(1)).toEqual([10, 20, 30]);
  });
});

describe('removeTrackFromPlaylist', () => {
  it('оптимистично убирает трек', async () => {
    const requests = fakeRequests();
    await removeTrackFromPlaylist(1, 10, requests);
    expect(requests.remove).toHaveBeenCalledWith(1, 10);
    expect(rowsOf(1)).toEqual([20]);
  });

  it('500: трек возвращается на место', async () => {
    const requests = fakeRequests({ remove: vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'boom')) });
    await expect(removeTrackFromPlaylist(1, 10, requests)).rejects.toMatchObject({ status: 500 });
    expect(rowsOf(1).sort()).toEqual([10, 20]);
  });
});
