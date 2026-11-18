import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayResponse } from '@/lib/api/catalog';
import { ApiError } from '@/lib/api/errors';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import type { TFn } from '@/lib/i18n/messages';
import type { TrackView } from '@/lib/store/selectors';
import { makeTrack } from '@/test/factories';
import { retryDelay } from './use-remote-search';
import { createPlayRemote, PENDING_POLL_MS, PLAY_TOAST_ID, WAITING_TOAST_MS, type PlayRemoteDeps } from './play-remote';

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
  let path = '/search/album/rg-1';
  const libraryListeners = new Set<() => void>();
  const playerListeners = new Set<() => void>();
  let settle: { resolve: (r: PlayResponse) => void; reject: (e: unknown) => void } = {
    reject: () => undefined,
    resolve: () => undefined,
  };
  const deps: PlayRemoteDeps = {
    albumTracks: vi.fn(() => album),
    albumTracksByMbid: vi.fn(() => album),
    canPlay: v => v.status === 'found' || v.status === 'ready',
    currentTrackId: () => current,
    findTrack: vi.fn((r: { mbid: string; trackId?: number }) =>
      r.trackId !== undefined ? [...tracks.values()].find(v => v.id === r.trackId) : tracks.get(r.mbid),
    ),
    play: vi.fn((track: { id: number }) => {
      current = track.id;
      playerListeners.forEach(l => l());
    }),
    fetchStatus: vi.fn(() => Promise.resolve<TrackView['status']>('adding')),
    request: vi.fn(() => new Promise<PlayResponse>((resolve, reject) => (settle = { reject, resolve }))),
    requestSync: vi.fn(),
    now: () => Date.now(),
    pathname: () => path,
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
    respond: async (ids: number[] = [11], status: PlayResponse['tracks'][number]['status'] = 'adding') => {
      settle.resolve({ album_id: 7, track_ids: ids, tracks: ids.map(id => ({ id, status })) });
      await flush();
    },
    respondWith: async (tracks: PlayResponse['tracks']) => {
      settle.resolve({ album_id: 7, track_ids: tracks.map(x => x.id), tracks });
      await flush();
    },
    setAlbum: (list: TrackView[]) => (album = list),
    setPath: (p: string) => (path = p),
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('playRemote', () => {
  it('трек уже на сервере и доступен (даже не в библиотеке) — играет сразу, без запроса; очередь — только он', () => {
    const h = harness();
    h.setTrack(REC, view());
    h.pr.playRemote(request, t);
    expect(h.deps.play).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), [
      expect.objectContaining({ id: 11 }),
    ]);
    expect(h.deps.request).not.toHaveBeenCalled();
    expect(pending(h)).toBeNull();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it('трека нет: «сыграть» без добавления в библиотеку, toast ожидания; заигрывает, когда стал found', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    expect(h.deps.request).toHaveBeenCalledWith({ albumMbid: 'rg-1', mbid: REC, type: 'track' }, expect.any(AbortSignal));
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
    await h.fail(new ApiError(404, 'mb_not_found', 'Not found in MusicBrainz'));
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
    expect(h.deps.request).toHaveBeenCalledWith({ mbid: 'rg-1', type: 'album' }, expect.any(AbortSignal));
    await h.respond([11, 12, 13]);
    const first = view();
    const second = view({ id: 12, mbid_recording: 'rec-2', position: 2 });
    const searching = view({ id: 13, mbid_recording: 'rec-3', status: 'adding' });
    h.setAlbum([first, second, searching]);
    h.setTrack(REC, first);
    expect(h.deps.albumTracks).toHaveBeenCalledWith(7);
    // Очередь — весь треклист: трек 13 ещё ищется, но подхватится, когда найдётся.
    expect(vi.mocked(h.deps.play).mock.calls[0]?.[1].map(q => q.id)).toEqual([11, 12, 13]);
  });

  it('«Слушать альбом»: первый трек уже доступен — играет сразу, остальным источник ищется в фоне', () => {
    const h = harness();
    h.setAlbum([view()]);
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

  it('server_adding_then_store_not_found_reports_no_source', async () => {
    const h = harness();
    h.setTrack(REC, view({ status: 'not_found' }));
    h.pr.playRemote(request, t);
    await h.respond([11], 'adding');
    // Прежняя строка не считается итогом, пока она не сменилась.
    expect(pending(h)).not.toBeNull();
    // Промежуточный `adding` потерян (пачка событий / переподключение): сразу итог.
    h.setTrack(REC, view({ status: 'not_found' }));
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
  });

  it('track_absent_until_final_state', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond([11], 'adding');
    expect(pending(h)?.searched).toBe(true);
    h.setTrack(REC, view({ status: 'not_found' }));
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
  });

  it('сервер сразу сказал found — играет, когда строка дойдёт до store', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond([11], 'found');
    expect(h.deps.play).not.toHaveBeenCalled();
    h.setTrack(REC, view({ status: 'found' }));
    expect(h.deps.play).toHaveBeenCalledOnce();
  });

  it('сервер сказал not_found (гонка) — toast без источника', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond([11], 'not_found');
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
  });

  it('в ответе нет нужного трека — ожидание снимается с ошибкой, а не висит', async () => {
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond([]);
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalled();
  });

  it('строка пропала из store после prune и не вернулась за круг сторожа — ожидание снимается', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.pr.playRemote(request, t);
    await h.respond();
    h.setTrack(REC, view({ status: 'adding' }));
    h.setTrack(REC, null);
    // Сразу — ещё нет: пересинхронизация может вернуть строку.
    expect(pending(h)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
    expect(pending(h)).toBeNull();
    expect(toast.error).toHaveBeenCalled();
  });

  describe('«Слушать альбом»', () => {
    const album = { ...request, context: 'album' as const, title: 'Album', wholeAlbum: true };
    const rec = (n: number, status: TrackView['status']) =>
      view({ id: 10 + n, mbid_recording: `rec-${n}`, position: n, status });

    it('whole_album_plays_first_playable_when_first_track_not_found', async () => {
      const h = harness();
      h.pr.playRemote(album, t);
      await h.respondWith([
        { id: 11, status: 'adding' },
        { id: 12, status: 'adding' },
      ]);
      h.setAlbum([rec(1, 'adding'), rec(2, 'adding')]);
      h.setTrack('x', null);
      // Первый не нашёлся, второй найден — играет второй, без toast об ошибке.
      h.setAlbum([rec(1, 'not_found'), rec(2, 'found')]);
      h.setTrack('x', view());
      expect(h.deps.play).toHaveBeenCalledOnce();
      expect(vi.mocked(h.deps.play).mock.calls[0]?.[0]).toMatchObject({ id: 12 });
      expect(vi.mocked(h.deps.play).mock.calls[0]?.[1].map(q => q.id)).toEqual([11, 12]);
      expect(toast.error).not.toHaveBeenCalled();
      expect(pending(h)).toBeNull();
    });

    it('whole_album_plays_available_immediately', async () => {
      const h = harness();
      h.setAlbum([rec(1, 'not_found'), rec(2, 'not_found'), rec(3, 'found'), rec(4, 'ready')]);
      h.pr.playRemote(album, t);
      // В обработчике клика, без ожидания ответа; запрос на альбом уходит в фоне.
      expect(vi.mocked(h.deps.play).mock.calls[0]?.[0]).toMatchObject({ id: 13 });
      expect(h.deps.request).toHaveBeenCalledWith({ mbid: 'rg-1', type: 'album' });
      expect(pending(h)).toBeNull();
      expect(toast.loading).not.toHaveBeenCalled();
    });

    it('whole_album_reports_no_source_only_when_nothing_left', async () => {
      const h = harness();
      h.pr.playRemote(album, t);
      await h.respondWith([
        { id: 11, status: 'adding' },
        { id: 12, status: 'adding' },
      ]);
      h.setAlbum([rec(1, 'adding'), rec(2, 'adding')]);
      h.setTrack('x', view());
      h.setAlbum([rec(1, 'not_found'), rec(2, 'adding')]);
      h.setTrack('x', view());
      // Второй ещё ищется — ждём.
      expect(pending(h)).not.toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
      h.setAlbum([rec(1, 'not_found'), rec(2, 'not_found')]);
      h.setTrack('x', view());
      expect(pending(h)).toBeNull();
      expect(toast.error).toHaveBeenCalledOnce();
    });

    it('прежние not_found в store не считаются итогом, пока события поиска не дошли', async () => {
      const h = harness();
      h.setAlbum([rec(1, 'not_found'), rec(2, 'not_found')]);
      h.pr.playRemote(album, t);
      await h.respondWith([
        { id: 11, status: 'adding' },
        { id: 12, status: 'adding' },
      ]);
      h.setTrack('x', view());
      expect(pending(h)).not.toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('album_queue_contains_whole_tracklist: нажатие на трек в контексте альбома — вся очередь', () => {
      const h = harness();
      h.setAlbum([rec(1, 'found'), rec(2, 'adding'), rec(3, 'not_found')]);
      h.setTrack(REC, rec(1, 'found'));
      h.pr.playRemote({ ...request, context: 'album' }, t);
      expect(vi.mocked(h.deps.play).mock.calls[0]?.[1].map(q => q.id)).toEqual([11, 12, 13]);
    });

    it('источник есть, но играть нельзя (нет связи) — подсказка, а не «не найден»', async () => {
      const h = harness();
      h.pr.playRemote(album, t);
      await h.respondWith([{ id: 11, status: 'found' }]);
      h.deps.canPlay = () => false;
      h.setAlbum([rec(1, 'found')]);
      h.setTrack('x', view());
      expect(pending(h)).toBeNull();
      expect(toast.info).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('сторож альбома: догоняет store дельтой', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(album, t);
      await h.respondWith([{ id: 11, status: 'adding' }]);
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      expect(h.deps.requestSync).toHaveBeenCalled();
      expect(h.deps.fetchStatus).not.toHaveBeenCalled();
    });
  });

  describe('обратная связь', () => {
    it('повторное нажатие отменяет не молча: toast «Ожидание отменено»', () => {
      const h = harness();
      h.pr.playRemote(request, t);
      h.pr.playRemote(request, t);
      expect(pending(h)).toBeNull();
      expect(toast.info).toHaveBeenCalledWith('Waiting cancelled', expect.objectContaining({ id: PLAY_TOAST_ID }));
    });

    it('отмена из индикатора (userCancel) и из toast — то же; тихая cancel — без сообщения', () => {
      const h = harness();
      h.pr.playRemote(request, t);
      h.pr.userCancel();
      expect(pending(h)).toBeNull();
      expect(toast.info).toHaveBeenCalledTimes(1);
      h.pr.playRemote(request, t);
      h.pr.cancel();
      expect(toast.info).toHaveBeenCalledTimes(1);
      // Нечего отменять — сообщения нет.
      h.pr.userCancel();
      expect(toast.info).toHaveBeenCalledTimes(1);
    });

    it('заиграло на другом экране — toast «Играет …»; на том же — без него', async () => {
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      h.setPath('/library');
      h.setTrack(REC, view());
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringContaining('Song'),
        expect.objectContaining({ id: PLAY_TOAST_ID }),
      );
      vi.mocked(toast.info).mockClear();
      const other = harness();
      other.pr.playRemote(request, t);
      await other.respond();
      other.setTrack(REC, view());
      expect(other.deps.play).toHaveBeenCalledOnce();
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('ответ сервера запоминает альбом (для стадии поиска)', async () => {
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      expect(pending(h)?.albumId).toBe(7);
    });
  });

  describe('запрос и повторы', () => {
    const unavailable = () => new ApiError(503, 'mb_unavailable', 'MusicBrainz is unavailable');
    const signalOf = (h: ReturnType<typeof harness>, n = 0) =>
      vi.mocked(h.deps.request).mock.calls[n]?.[1] as AbortSignal;

    it('cancel_aborts_request: отмена и замена ожидания обрывают запрос', async () => {
      const h = harness();
      h.pr.playRemote(request, t);
      const first = signalOf(h);
      expect(first.aborted).toBe(false);
      h.pr.playRemote({ ...request, mbid: 'rec-2', title: 'Other' }, t);
      expect(first.aborted).toBe(true);
      const second = signalOf(h, 1);
      h.pr.cancel();
      expect(second.aborted).toBe(true);
      // Обрыв — не ошибка: без toast.
      await h.fail(new DOMException('aborted', 'AbortError'));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('retries_once_on_503: один повтор через retryDelay(1), в индикаторе — «пробуем ещё раз»', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.fail(unavailable());
      expect(pending(h)?.retrying).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();
      expect(h.deps.request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(retryDelay(1));
      expect(h.deps.request).toHaveBeenCalledTimes(2);
      await h.respond();
      expect(pending(h)).toMatchObject({ retrying: false, trackId: 11 });
    });

    it('сетевая ошибка тоже повторяется один раз', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.fail(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(retryDelay(1));
      expect(h.deps.request).toHaveBeenCalledTimes(2);
    });

    it('second_503_shows_retry_toast: вторая неудача — ошибка с кнопкой «Повторить»', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.fail(unavailable());
      await vi.advanceTimersByTimeAsync(retryDelay(1));
      await h.fail(unavailable());
      expect(pending(h)).toBeNull();
      const opts = vi.mocked(toast.error).mock.calls[0]?.[1] as unknown as { action: { label: string; onClick: () => void } };
      expect(opts.action.label).toBe('Retry');
      opts.action.onClick();
      expect(h.deps.request).toHaveBeenCalledTimes(3);
      expect(pending(h)).not.toBeNull();
    });

    it('отмена во время паузы перед повтором снимает таймер', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.fail(unavailable());
      h.pr.cancel();
      await vi.advanceTimersByTimeAsync(retryDelay(1) * 3);
      expect(h.deps.request).toHaveBeenCalledOnce();
    });

    it('4xx не повторяется и без кнопки «Повторить»', async () => {
      const h = harness();
      h.pr.playRemote(request, t);
      await h.fail(new ApiError(422, 'recording_not_in_release', 'x'));
      expect(toast.error).toHaveBeenCalledWith(expect.any(String), { action: undefined, id: PLAY_TOAST_ID });
      expect(h.deps.request).toHaveBeenCalledOnce();
    });
  });

  describe('сторож', () => {
    it('watchdog_polls_when_store_is_silent', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      expect(h.deps.fetchStatus).not.toHaveBeenCalled();
      vi.mocked(h.deps.fetchStatus).mockResolvedValue('found');
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      expect(h.deps.fetchStatus).toHaveBeenCalledWith(11);
      expect(h.deps.requestSync).toHaveBeenCalledOnce();
      // Синхронизация догнала store — играет.
      h.setTrack(REC, view({ status: 'found' }));
      expect(h.deps.play).toHaveBeenCalledOnce();
      // Ожидание снято — таймер больше не опрашивает.
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 2);
      expect(h.deps.fetchStatus).toHaveBeenCalledOnce();
    });

    it('сервер говорит not_found, а store молчит — toast без источника', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      vi.mocked(h.deps.fetchStatus).mockResolvedValue('not_found');
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      expect(pending(h)).toBeNull();
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No source'), { id: PLAY_TOAST_ID });
    });

    it('всё ещё adding — опрашивает снова; сетевая ошибка не снимает ожидание, 404 снимает', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      vi.mocked(h.deps.fetchStatus).mockRejectedValueOnce(new Error('offline'));
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      expect(h.deps.fetchStatus).toHaveBeenCalledTimes(2);
      expect(pending(h)).not.toBeNull();
      vi.mocked(h.deps.fetchStatus).mockRejectedValueOnce(new ApiError(404, 'not_found', 'gone'));
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
      expect(pending(h)).toBeNull();
    });

    it('отмена останавливает сторожа', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.pr.playRemote(request, t);
      await h.respond();
      h.pr.cancel();
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 2);
      expect(h.deps.fetchStatus).not.toHaveBeenCalled();
    });
  });
});
