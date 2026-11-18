import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import type { TFn } from '@/lib/i18n/messages';
import type { TrackStatus, TrackView } from '@/lib/store/selectors';
import { makeTrack } from '@/test/factories';
import { createPlayRemote, PLAY_TOAST_ID, WAITING_TOAST_MS, type PlayRemoteDeps } from './play-remote';

const t = ((key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params)) as TFn;

const REC = 'rec-1';
const view = (over: Partial<TrackView> = {}): TrackView => ({
  ...makeTrack({ album_id: 7, id: 11, mbid_recording: REC, status: 'found', title: 'Song' }),
  albumTitle: 'Album',
  artistName: 'Artist',
  coverUrl: null,
  ...over,
});

/** Фейковые библиотека и плеер: `setTrack` меняет библиотеку и уведомляет подписчиков, `setCurrent` — плеер. */
function harness() {
  let tracks = new Map<string, TrackView>();
  let album: TrackView[] = [];
  let current: number | null = null;
  const libraryListeners = new Set<() => void>();
  const playerListeners = new Set<() => void>();
  let resolveAdd: (ok: boolean) => void = () => undefined;
  const deps: PlayRemoteDeps = {
    add: vi.fn(() => new Promise<boolean>(r => (resolveAdd = r))),
    albumTracks: vi.fn(() => album),
    canPlay: v => v.status === 'found' || v.status === 'ready',
    currentTrackId: () => current,
    findTrack: r => tracks.get(r.mbid),
    play: vi.fn((track: { id: number }) => {
      current = track.id;
      playerListeners.forEach(l => l());
    }),
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
  return {
    deps,
    finishAdd: async (ok: boolean) => {
      resolveAdd(ok);
      await Promise.resolve();
      await Promise.resolve();
    },
    libraryListeners,
    playerListeners,
    pr,
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

beforeEach(() => {
  vi.spyOn(toast, 'loading').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'error').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'info').mockReturnValue(PLAY_TOAST_ID);
  vi.spyOn(toast, 'dismiss').mockReturnValue(PLAY_TOAST_ID);
});
afterEach(() => vi.restoreAllMocks());

describe('playRemote', () => {
  it('трек в библиотеке и доступен — играет сразу, без добавления; очередь — только он', () => {
    const h = harness();
    h.setTrack(REC, view());
    h.pr.playRemote(request, t);
    expect(h.deps.play).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), [expect.objectContaining({ id: 11 })]);
    expect(h.deps.add).not.toHaveBeenCalled();
    expect(h.pr.store.getState().pending).toBeNull();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it('трека нет: добавляется трек в составе альбома, toast ожидания; заигрывает, когда стал found', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    expect(h.deps.add).toHaveBeenCalledWith(
      expect.objectContaining({ albumMbid: 'rg-1', mbid: REC, type: 'track' }),
      t,
    );
    expect(h.pr.store.getState().pending).toEqual(request);
    expect(toast.loading).toHaveBeenCalledWith(expect.stringContaining('Song'), expect.objectContaining({ id: PLAY_TOAST_ID }));
    await h.finishAdd(true);
    // Дельта принесла трек, но источник ещё ищется.
    h.setTrack(REC, view({ status: 'adding' }));
    expect(h.deps.play).not.toHaveBeenCalled();
    h.setTrack(REC, view({ status: 'found' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
    expect(h.pr.store.getState().pending).toBeNull();
    expect(toast.dismiss).toHaveBeenCalledWith(PLAY_TOAST_ID);
    // Подписки сняты: ожидание не висит.
    expect(h.libraryListeners.size).toBe(0);
    expect(h.playerListeners.size).toBe(0);
  });

  it('источник не найден — ожидание снимается, toast с ошибкой', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.finishAdd(true);
    h.setTrack(REC, view({ status: 'not_found' as TrackStatus }));
    expect(h.deps.play).not.toHaveBeenCalled();
    expect(h.pr.store.getState().pending).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
  });

  it('уже в библиотеке без источника: not_found — ошибка сразу, без добавления', () => {
    const h = harness();
    h.setTrack(REC, view({ status: 'not_found' }));
    h.pr.playRemote(request, t);
    expect(h.deps.add).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    expect(h.pr.store.getState().pending).toBeNull();
  });

  it('уже в библиотеке и ищется: ждёт без повторного добавления', () => {
    const h = harness();
    h.setTrack(REC, view({ status: 'adding' }));
    h.pr.playRemote(request, t);
    expect(h.deps.add).not.toHaveBeenCalled();
    expect(h.pr.store.getState().pending).toEqual(request);
    h.setTrack(REC, view({ status: 'ready' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
  });

  it('добавление не удалось — ожидание снимается', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.finishAdd(false);
    expect(h.pr.store.getState().pending).toBeNull();
    expect(toast.dismiss).toHaveBeenCalledWith(PLAY_TOAST_ID);
    h.setTrack(REC, view());
    expect(h.deps.play).not.toHaveBeenCalled();
  });

  it('трек уже приехал к ответу на добавление — играет сразу после ответа', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    // Дельта пришла раньше ответа POST, а подписки ещё нет — проверка после ответа.
    h.libraryListeners.clear();
    h.setTrack(REC, view());
    await h.finishAdd(true);
    expect(h.deps.play).toHaveBeenCalledOnce();
  });

  it('пользователь включил другой трек — ожидание отменяется', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.finishAdd(true);
    h.setCurrent(99);
    expect(h.pr.store.getState().pending).toBeNull();
    h.setTrack(REC, view());
    expect(h.deps.play).not.toHaveBeenCalled();
  });

  it('новый запуск заменяет прежнее ожидание; отмена — из toast', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    const other = { ...request, mbid: 'rec-2', title: 'Other' };
    h.pr.playRemote(other, t);
    expect(h.pr.store.getState().pending).toEqual(other);
    expect(h.libraryListeners.size).toBe(1);
    const opts = vi.mocked(toast.loading).mock.calls[1]?.[1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(h.pr.store.getState().pending).toBeNull();
    expect(h.libraryListeners.size).toBe(0);
    await h.finishAdd(true);
    h.setTrack('rec-2', view({ id: 12, mbid_recording: 'rec-2' }));
    expect(h.deps.play).not.toHaveBeenCalled();
    // Повторная отмена ничего не делает.
    h.pr.cancel();
  });

  it('«Слушать» у альбома: добавляется альбом; очередь — доступные треки альбома', async () => {
    const h = harness();
    h.pr.playRemote({ ...request, addAlbum: true, context: 'album', title: 'Album' }, t);
    expect(h.deps.add).toHaveBeenCalledWith(expect.objectContaining({ mbid: 'rg-1', type: 'album' }), t);
    await h.finishAdd(true);
    const first = view();
    const second = view({ id: 12, mbid_recording: 'rec-2', position: 2 });
    const searching = view({ id: 13, mbid_recording: 'rec-3', status: 'adding' });
    const outside = view({ id: 14, in_library: false, mbid_recording: 'rec-4' });
    h.setAlbum([first, second, searching, outside]);
    h.setTrack(REC, first);
    expect(h.deps.albumTracks).toHaveBeenCalledWith(7);
    const queue = vi.mocked(h.deps.play).mock.calls[0]?.[1];
    expect(queue?.map(q => q.id)).toEqual([11, 12]);
  });
  it('повторное нажатие на ожидающий трек отменяет ожидание; toast ожидания не бесконечный', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    expect(toast.loading).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: WAITING_TOAST_MS }));
    h.pr.playRemote(request, t);
    expect(h.pr.store.getState().pending).toBeNull();
    expect(h.deps.add).toHaveBeenCalledOnce();
    await h.finishAdd(true);
    h.setTrack(REC, view());
    expect(h.deps.play).not.toHaveBeenCalled();
  });
  it('источник есть, но играть нельзя (нет связи, не скачан) — подсказка вместо бесконечного ожидания', () => {
    const h = harness();
    h.deps.canPlay = () => false;
    h.setTrack(REC, view({ status: 'found' }));
    h.pr.playRemote(request, t);
    expect(h.pr.store.getState().pending).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), { id: PLAY_TOAST_ID });
    expect(h.deps.add).not.toHaveBeenCalled();
  });

  it('«Слушать альбом»: первый трек уже доступен — играет сразу, а альбом всё равно добавляется', () => {
    const h = harness();
    h.setTrack(REC, view());
    h.pr.playRemote({ ...request, addAlbum: true, context: 'album' }, t);
    expect(h.deps.play).toHaveBeenCalledOnce();
    expect(h.deps.add).toHaveBeenCalledWith(expect.objectContaining({ mbid: 'rg-1', type: 'album' }), t);
  });

  it('«Слушать альбом» ждёт первый трек — нажатие на сам трек не отменяет, а заменяет ожидание', () => {
    const h = harness();
    h.pr.playRemote({ ...request, addAlbum: true }, t);
    h.pr.playRemote(request, t);
    expect(h.pr.store.getState().pending).toEqual(request);
  });
});
