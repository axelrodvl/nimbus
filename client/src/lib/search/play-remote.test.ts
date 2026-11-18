import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayResponse } from '@/lib/api/catalog';
import { ApiError } from '@/lib/api/errors';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import type { TFn } from '@/lib/i18n/messages';
import type { TrackView } from '@/lib/store/selectors';
import { makeTrack } from '@/test/factories';
import { createPlayRemote, PLAY_TOAST_ID, WAITING_TOAST_MS, type PlayRemoteDeps } from './play-remote';

const t = ((key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params)) as TFn;

const REC = 'rec-1';
const view = (over: Partial<TrackView> = {}): TrackView => ({
  ...makeTrack({ album_id: 7, id: 11, in_library: false, mbid_recording: REC, status: 'found', title: 'Song' }),
  albumTitle: 'Album',
  artistName: 'Artist',
  coverUrl: null,
  ...over,
});

/** Фейковые store и плеер: `setTrack` меняет store и уведомляет подписчиков, `setCurrent` — плеер. */
function harness() {
  let tracks = new Map<string, TrackView>();
  let album: TrackView[] = [];
  let current: number | null = null;
  const libraryListeners = new Set<() => void>();
  const playerListeners = new Set<() => void>();
  let settle: { resolve: (r: PlayResponse) => void; reject: (e: unknown) => void } = {
    reject: () => undefined,
    resolve: () => undefined,
  };
  const deps: PlayRemoteDeps = {
    albumTracks: vi.fn(() => album),
    canPlay: v => v.status === 'found' || v.status === 'ready',
    currentTrackId: () => current,
    findTrack: vi.fn((r: { mbid: string; trackId?: number }) =>
      r.trackId !== undefined ? [...tracks.values()].find(v => v.id === r.trackId) : tracks.get(r.mbid),
    ),
    play: vi.fn((track: { id: number }) => {
      current = track.id;
      playerListeners.forEach(l => l());
    }),
    request: vi.fn(() => new Promise<PlayResponse>((resolve, reject) => (settle = { reject, resolve }))),
    subscribeLibrary: l => {
      libraryListeners.add(l);
      return () => libraryListeners.delete(l);
    },
    subscribePlayer: l => {
      playerListeners.add(l);
      return () => playerListeners.delete(l);
    },
  };
  const pr = createPlayRemote(deps);
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    deps,
    fail: async (e: unknown) => {
      settle.reject(e);
      await flush();
    },
    libraryListeners,
    playerListeners,
    pr,
    respond: async (ids: number[] = [11]) => {
      settle.resolve({ album_id: 7, track_ids: ids });
      await flush();
    },
    setAlbum: (list: TrackView[]) => (album = list),
    setCurrent: (id: number | null) => {
      current = id;
      playerListeners.forEach(l => l());
    },
    setTrack: (mbid: string, v: TrackView | null) => {
      tracks = new Map(tracks);
      if (v) tracks.set(mbid, v);
      else tracks.delete(mbid);
      libraryListeners.forEach(l => l());
    },
  };
}

const request = { albumMbid: 'rg-1', mbid: REC, title: 'Song' };
const pending = (h: ReturnType<typeof harness>) => h.pr.store.getState().pending;

beforeEach(() => {
  vi.spyOn(toast, 'loading').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'error').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'info').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'dismiss').mockReturnValue(PLAY_TOAST_ID);
});
afterEach(() => vi.restoreAllMocks());

describe('playRemote', () => {
  it('трек уже на сервере и доступен (даже не в библиотеке) — играет сразу, без запроса; очередь — только он', () => {
    const h = harness();
    h.setTrack(REC, view());
    h.pr.playRemote(request, t);
    expect(h.deps.play).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), [expect.objectContaining({ id: 11 })]);
    expect(h.deps.request).not.toHaveBeenCalled();
    expect(pending(h)).toBeNull();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it('трека нет: «сыграть» без добавления в библиотеку, toast ожидания; заигрывает, когда стал found', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    expect(h.deps.request).toHaveBeenCalledWith({ albumMbid: 'rg-1', mbid: REC, type: 'track' });
    expect(pending(h)?.request).toEqual(request);
    expect(toast.loading).toHaveBeenCalledWith(
      expect.stringContaining('Song'),
      expect.objectContaining({ duration: WAITING_TOAST_MS, id: PLAY_TOAST_ID }),
    );
    await h.respond([11]);
    expect(pending(h)?.trackId).toBe(11);
    // Синхронизация принесла трек, источник ищется.
    h.setTrack(REC, view({ status: 'adding' }));
    expect(h.deps.play).not.toHaveBeenCalled();
    h.setTrack(REC, view({ status: 'found' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
    expect(pending(h)).toBeNull();
    expect(toast.dismiss).toHaveBeenCalledWith(PLAY_TOAST_ID);
    // Подписки сняты: ожидание не висит.
    expect(h.libraryListeners.size).toBe(0);
    expect(h.playerListeners.size).toBe(0);
  });

  it('поиск закончился без источника — ожидание снимается, toast с ошибкой', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond();
    h.setTrack(REC, view({ status: 'adding' }));
    h.setTrack(REC, view({ status: 'not_found' }));
    expect(h.deps.play).not.toHaveBeenCalled();
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
  });

  it('прежний not_found не считается итогом, пока сервер не начал поиск заново', async () => {
    const h = harness();
    h.setTrack(REC, view({ status: 'not_found' }));
    h.pr.playRemote(request, t);
    expect(h.deps.request).toHaveBeenCalledOnce();
    await h.respond();
    expect(pending(h)).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    h.setTrack(REC, view({ status: 'adding' }));
    h.setTrack(REC, view({ status: 'found' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
  });

  it('уже ищется: ждёт; ответ сервера после запуска ничего не делает', async () => {
    const h = harness();
    h.setTrack(REC, view({ status: 'adding' }));
    h.pr.playRemote(request, t);
    expect(pending(h)?.searched).toBe(true);
    h.setTrack(REC, view({ status: 'ready' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
    await h.respond();
    expect(h.deps.play).toHaveBeenCalledOnce();
  });

  it('источник есть, но играть нельзя (нет связи, не скачан) — подсказка, без запроса', () => {
    const h = harness();
    h.deps.canPlay = () => false;
    h.setTrack(REC, view({ status: 'found' }));
    h.pr.playRemote(request, t);
    expect(pending(h)).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), { id: PLAY_TOAST_ID });
    expect(h.deps.request).not.toHaveBeenCalled();
  });

  it('во время ожидания пропала связь, а трек стал found — подсказка вместо бесконечного спиннера', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond();
    h.deps.canPlay = () => false;
    h.setTrack(REC, view({ status: 'found' }));
    expect(pending(h)).toBeNull();
    expect(toast.info).toHaveBeenCalled();
  });

  it('сервер отказал — ожидание снимается, toast с ошибкой', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.fail(new ApiError(503, 'mb_unavailable', 'MusicBrainz is unavailable'));
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), { id: PLAY_TOAST_ID });
  });

  it('пользователь включил другой трек — ожидание отменяется', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond();
    h.setCurrent(99);
    expect(pending(h)).toBeNull();
    h.setTrack(REC, view());
    expect(h.deps.play).not.toHaveBeenCalled();
  });

  it('новый запуск заменяет прежнее ожидание; отмена — из toast; ответ на отменённый игнорируется', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    const other = { ...request, mbid: 'rec-2', title: 'Other' };
    h.pr.playRemote(other, t);
    expect(pending(h)?.request).toEqual(other);
    expect(h.libraryListeners.size).toBe(1);
    const opts = vi.mocked(toast.loading).mock.calls[1]?.[1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(pending(h)).toBeNull();
    expect(h.libraryListeners.size).toBe(0);
    await h.respond([12]);
    expect(pending(h)).toBeNull();
    h.pr.cancel();
  });

  it('ошибка запроса, который уже отменён, — без toast', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    h.pr.cancel();
    await h.fail(new Error('late'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('повторное нажатие на ожидающий трек отменяет ожидание', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    h.pr.playRemote(request, t);
    expect(pending(h)).toBeNull();
    expect(h.deps.request).toHaveBeenCalledOnce();
    await h.respond();
    h.setTrack(REC, view());
    expect(h.deps.play).not.toHaveBeenCalled();
  });

  it('«Слушать альбом»: запрос по альбому; ждёт первый трек; очередь — доступные треки альбома (в библиотеке или нет)', async () => {
    const h = harness();
    h.pr.playRemote({ ...request, context: 'album', title: 'Album', wholeAlbum: true }, t);
    expect(h.deps.request).toHaveBeenCalledWith({ mbid: 'rg-1', type: 'album' });
    await h.respond([11, 12, 13]);
    const first = view();
    const second = view({ id: 12, mbid_recording: 'rec-2', position: 2 });
    const searching = view({ id: 13, mbid_recording: 'rec-3', status: 'adding' });
    h.setAlbum([first, second, searching]);
    h.setTrack(REC, first);
    expect(h.deps.albumTracks).toHaveBeenCalledWith(7);
    expect(vi.mocked(h.deps.play).mock.calls[0]?.[1].map(q => q.id)).toEqual([11, 12]);
  });

  it('«Слушать альбом»: первый трек уже доступен — играет сразу, остальным источник ищется в фоне', () => {
    const h = harness();
    h.setTrack(REC, view());
    h.pr.playRemote({ ...request, context: 'album', wholeAlbum: true }, t);
    expect(h.deps.play).toHaveBeenCalledOnce();
    expect(h.deps.request).toHaveBeenCalledWith({ mbid: 'rg-1', type: 'album' });
  });

  it('«Слушать альбом» ждёт первый трек — нажатие на сам трек не отменяет, а заменяет ожидание', () => {
    const h = harness();
    h.pr.playRemote({ ...request, wholeAlbum: true }, t);
    h.pr.playRemote(request, t);
    expect(pending(h)?.request).toEqual(request);
  });
});
