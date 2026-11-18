import { act } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as searchApi from '@/lib/api/search';
import { appData } from '@/lib/app-data';
import { en } from '@/lib/i18n/messages/en';
import type { TFn } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetPlayer, toPlayerTrack } from '@/lib/player';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { installTestPlayer } from '@/test/player-ui';
import { seed } from '@/test/seed';
import { addingStore } from './add';
import { playRemoteApp } from './play-remote';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
}));
const post = vi.mocked(searchApi.addToLibraryRequest);

const t = ((key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params)) as TFn;

const rows = (status: 'adding' | 'found') => ({
  albums: [makeAlbum({ artist_id: 1, id: 2, mbid: 'rg', title: 'Alb' })],
  artists: [makeArtist({ id: 1 })],
  tracks: [
    makeTrack({ album_id: 2, artist_id: 1, id: 10, mbid_recording: 'rec-a', position: 1, status, title: 'A' }),
    makeTrack({ album_id: 2, artist_id: 1, id: 11, mbid_recording: 'rec-b', position: 2, status: 'ready', title: 'B' }),
  ],
});

beforeEach(() => {
  resetFactories();
  vi.spyOn(toast, 'loading').mockReturnValue(1);
  vi.spyOn(toast, 'dismiss').mockReturnValue(1);
  vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
});
afterEach(() => {
  playRemoteApp().cancel();
  resetPlayer(true);
  addingStore.setState({ adding: new Map() });
  vi.restoreAllMocks();
});

describe('playRemoteApp: связка с библиотекой и плеером приложения', () => {
  it('трек из библиотеки — играет сразу; в контексте альбома очередь — доступные треки альбома', () => {
    seed(rows('found'));
    const env = installTestPlayer();
    playRemoteApp().playRemote({ albumMbid: 'rg', context: 'album', mbid: 'rec-a', title: 'A' }, t);
    expect(env.ctl.state.queue.map(q => q.id)).toEqual([10, 11]);
    expect(post).not.toHaveBeenCalled();
  });

  it('трека нет — добавляется без своего toast «добавлено»; заигрывает, когда дельта принесла его найденным', async () => {
    seed({ albums: [], artists: [], tracks: [] });
    const env = installTestPlayer();
    const success = vi.spyOn(toast, 'success');
    post.mockResolvedValue({ id: 10, status: 'added', type: 'track' });
    playRemoteApp().playRemote({ albumMbid: 'rg', mbid: 'rec-a', title: 'A' }, t);
    await act(async () => undefined);
    expect(post).toHaveBeenCalledWith({ albumMbid: 'rg', mbid: 'rec-a', type: 'track' });
    expect(success).not.toHaveBeenCalled();
    act(() => seed(rows('adding')));
    expect(env.ctl.state.queue).toEqual([]);
    act(() => seed(rows('found')));
    expect(env.ctl.state.queue.map(q => q.id)).toEqual([10]);
    expect(playRemoteApp().store.getState().pending).toBeNull();
  });

  it('пока ждём, пользователь включил другой трек — ожидание снимается', async () => {
    seed(rows('adding'));
    const env = installTestPlayer();
    playRemoteApp().playRemote({ albumMbid: 'rg', mbid: 'rec-a', title: 'A' }, t);
    expect(playRemoteApp().store.getState().pending).not.toBeNull();
    const other = appData().selectors.trackView(appData().library.getState(), 11)!;
    act(() => env.ctl.play(toPlayerTrack(other)));
    expect(playRemoteApp().store.getState().pending).toBeNull();
  });
  it('одна запись в двух альбомах: играет именно нажатый трек (trackId) или копия из нужного альбома', () => {
    seed({
      albums: [
        makeAlbum({ artist_id: 1, id: 2, mbid: 'rg', title: 'Alb' }),
        makeAlbum({ artist_id: 1, id: 3, mbid: 'rg-best', title: 'Best Of' }),
      ],
      artists: [makeArtist({ id: 1 })],
      tracks: [
        makeTrack({ album_id: 2, artist_id: 1, id: 10, mbid_recording: 'rec-a', status: 'found', title: 'A' }),
        makeTrack({ album_id: 3, artist_id: 1, id: 30, mbid_recording: 'rec-a', status: 'found', title: 'A' }),
      ],
    });
    const env = installTestPlayer();
    const current = () => env.ctl.state.queue[env.ctl.state.index]?.id;
    playRemoteApp().playRemote({ albumMbid: null, mbid: 'rec-a', title: 'A', trackId: 30 }, t);
    expect(current()).toBe(30);
    playRemoteApp().playRemote({ albumMbid: 'rg', mbid: 'rec-a', title: 'A' }, t);
    expect(current()).toBe(10);
    // Альбома ещё нет в store — трек «не найден», значит добавляем и ждём.
    post.mockReturnValue(new Promise(() => undefined));
    playRemoteApp().playRemote({ albumMbid: 'rg-new', mbid: 'rec-a', title: 'A' }, t);
    expect(post).toHaveBeenCalledWith({ albumMbid: 'rg-new', mbid: 'rec-a', type: 'track' });
  });
});
