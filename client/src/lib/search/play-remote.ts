import { toast } from 'sonner';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { requestPlay, type PlayInput, type PlayResponse } from '@/lib/api/catalog';
import { apiErrorMessage } from '@/lib/api/error-message';
import { appData } from '@/lib/app-data';
import { ApiError } from '@/lib/api/errors';
import { getTrack } from '@/lib/api/tracks';
import type { TFn } from '@/lib/i18n/messages';
import { currentTrack } from '@/lib/player/engine';
import { player } from '@/lib/player/index';
import { canPlay, toPlayerTrack, type PlayerTrack } from '@/lib/player/track';
import type { TrackView } from '@/lib/store/selectors';

/** Трек из MusicBrainz (поиск, каталог), который нужно сыграть, — возможно, его ещё нет на сервере. */
export type PlayRemoteRequest = {
  /** MBID записи (recording). */
  mbid: string;
  /** Альбом (release group), в составе которого играть трек. */
  albumMbid: string | null;
  title: string;
  /** `album` — очередь из доступных треков его альбома (экран альбома); иначе — только он. */
  context?: 'single' | 'album';
  /** «Слушать альбом»: источник ищется всем трекам альбома, играет первый (`mbid`). */
  wholeAlbum?: boolean;
  /** Точный трек на сервере (локальный результат поиска): одна запись бывает в нескольких альбомах. */
  trackId?: number;
};

type Pending = {
  request: PlayRemoteRequest;
  /** id трека на сервере — известен после ответа `POST /api/play`. */
  trackId: number | null;
  /**
   * Поиск гарантированно начат после нажатия (трек видели в `adding` или так сказал сервер): `not_found` после этого —
   * итог поиска, а не устаревшая строка store.
   */
  searched: boolean;
  /** Строка трека уже побывала в store: если она исчезла (`prune`), ожидание не может завершиться. */
  seen: boolean;
  /**
   * Строка `not_found`, лежавшая в store на момент ответа сервера: это прежний итог (событие `adding` ещё в пути).
   * Итогом считается только другая строка (объект меняется вместе со строкой трека).
   */
  stale: TrackView | null;
};

type State = { pending: Pending | null };

export type PlayRemoteDeps = {
  /**
   * Трек в store (в библиотеке он или нет): по `trackId`; иначе запись в составе `albumMbid`; без альбома — любая копия.
   */
  findTrack: (request: Pick<PlayRemoteRequest, 'mbid' | 'albumMbid' | 'trackId'>) => TrackView | undefined;
  albumTracks: (albumId: number) => TrackView[];
  canPlay: (track: TrackView) => boolean;
  play: (track: PlayerTrack, queue: PlayerTrack[]) => void;
  /** `POST /api/play`: сыграть, не добавляя в библиотеку. */
  request: (input: PlayInput) => Promise<PlayResponse>;
  /** Статус трека на сервере напрямую (сторож, когда синхронизация молчит). */
  fetchStatus: (trackId: number) => Promise<TrackView['status']>;
  /** Догнать store до сервера (дельта синхронизации). */
  requestSync: () => void;
  subscribeLibrary: (listener: () => void) => () => void;
  /** id текущего трека плеера и подписка на его смену. */
  currentTrackId: () => number | null;
  subscribePlayer: (listener: () => void) => () => void;
};

/** Toast ожидания один на всё приложение: новый запуск заменяет прежний. */
export const PLAY_TOAST_ID = 'play-remote';
/** Сколько висит toast ожидания. */
export const WAITING_TOAST_MS = 8000;
/** Через сколько после ответа сервера (и далее с тем же шагом) сторож проверяет статус трека напрямую. */
export const PENDING_POLL_MS = 15_000;

const playInput = (r: PlayRemoteRequest): PlayInput =>
  r.wholeAlbum && r.albumMbid
    ? { mbid: r.albumMbid, type: 'album' }
    : { albumMbid: r.albumMbid, mbid: r.mbid, type: 'track' };

/**
 * «Нажал на трек — он играет», не добавляя его в библиотеку: сервер сохраняет метаданные и ищет источник
 * (`POST /api/play`), а запуск ждёт, пока синхронизация не скажет, что источник есть (`found`). Ожидание одно: новый
 * запуск заменяет прежний, повторное нажатие на то же — отменяет; пользователь включил что-то другое в плеере —
 * ожидание снимается (иначе трек внезапно заиграл бы поверх). Источник не найден — toast.
 */
export function createPlayRemote(deps: PlayRemoteDeps) {
  const store = createStore<State>(() => ({ pending: null }));
  let unsubscribe: (() => void) | null = null;
  let tRef: TFn | null = null;
  // Текущий трек плеера в момент постановки ожидания: смена на любой другой — отмена.
  let playerAtStart: number | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function stopWatching() {
    unsubscribe?.();
    unsubscribe = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function clear() {
    stopWatching();
    if (store.getState().pending) store.setState({ pending: null });
  }

  function cancel() {
    if (!store.getState().pending) return;
    clear();
    toast.dismiss(PLAY_TOAST_ID);
  }

  function start(view: TrackView, request: PlayRemoteRequest) {
    const track = toPlayerTrack(view);
    const queue =
      request.context === 'album'
        ? deps
            .albumTracks(view.album_id)
            .filter(v => v.id === view.id || deps.canPlay(v))
            .map(toPlayerTrack)
        : [track];
    deps.play(track, queue);
  }

  const lookup = (p: Pending) =>
    deps.findTrack(p.trackId === null ? p.request : { ...p.request, trackId: p.trackId });

  /**
   * Проверить ожидание: трек готов — играть; поиск закончился без источника — сообщить. Источник есть, но играть нельзя
   * (нет связи, а на устройство трек не скачан) — тоже сообщить, а не крутить спиннер без конца.
   */
  function check() {
    const pending = store.getState().pending;
    if (!pending || !tRef) return;
    const view = lookup(pending);
    if (!view) return;
    if (!pending.seen) store.setState({ pending: { ...pending, seen: true } });
    if (deps.canPlay(view)) {
      clear();
      toast.dismiss(PLAY_TOAST_ID);
      start(view, pending.request);
      return;
    }
    if (view.status === 'adding') {
      if (!pending.searched) store.setState({ pending: { ...pending, searched: true } });
      return;
    }
    if (view.status === 'not_found') {
      // Пока неизвестно, что поиск начат после нажатия, это прежний итог.
      if (pending.searched && view !== pending.stale) noSource(pending);
      return;
    }
    clear();
    toast.info(tRef('offline.hint.notDownloaded'), { id: PLAY_TOAST_ID });
  }

  function noSource(pending: Pending) {
    clear();
    if (tRef) toast.error(tRef('play.noSource', { title: pending.request.title }), { id: PLAY_TOAST_ID });
  }

  /**
   * Сторож: синхронизация могла замолчать (WS закрыт, пачка событий склеила итог). Спросить сервер напрямую:
   * итог «не найден» — сообщить; источник есть — догнать store, дальше `check()` по подписке.
   */
  function poll(pending: Pending) {
    const trackId = pending.trackId;
    if (trackId === null) return;
    // Строка была и пропала (`prune`) и за целый круг не вернулась (пересинхронизация успела бы) — итога уже не будет.
    if (pending.seen && !lookup(pending)) {
      noSource(pending);
      return;
    }
    deps.fetchStatus(trackId).then(
      status => {
        const now = store.getState().pending;
        if (now?.request !== pending.request) return;
        if (status === 'not_found') {
          if (now.searched) noSource(now);
        } else if (status !== 'adding') {
          deps.requestSync();
        }
      },
      (error: unknown) => {
        const now = store.getState().pending;
        if (now?.request !== pending.request) return;
        // Трека на сервере больше нет — ждать нечего; прочие ошибки (сеть) — подождём следующего круга.
        if (error instanceof ApiError && error.status === 404) noSource(now);
      },
    );
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const pending = store.getState().pending;
      if (pending) poll(pending);
    }, PENDING_POLL_MS);
  }

  function watch() {
    stopWatching();
    playerAtStart = deps.currentTrackId();
    const offLibrary = deps.subscribeLibrary(check);
    const offPlayer = deps.subscribePlayer(() => {
      if (deps.currentTrackId() !== playerAtStart) cancel();
    });
    unsubscribe = () => {
      offLibrary();
      offPlayer();
    };
  }

  /**
   * Сыграть трек. Уже на сервере и доступен — сразу (в цепочке клика: iOS требует жеста для звука). Иначе — попросить
   * сервер найти источник и ждать; toast «Ищем источник…» с кнопкой «Отмена». В библиотеку ничего не добавляется.
   */
  function playRemote(request: PlayRemoteRequest, t: TFn): void {
    tRef = t;
    // Повторное нажатие на то же (трек или «Слушать альбом»), что ждёт источника, — передумал: ожидание снимается.
    const current = store.getState().pending?.request;
    if (current && current.mbid === request.mbid && !!current.wholeAlbum === !!request.wholeAlbum) {
      cancel();
      return;
    }
    const own = deps.findTrack(request);
    if (own && deps.canPlay(own)) {
      cancel();
      start(own, request);
      // «Слушать альбом»: первый трек уже играет, остальным источник ищется в фоне.
      if (request.wholeAlbum) void deps.request(playInput(request)).catch(() => undefined);
      return;
    }
    if (own && (own.status === 'found' || own.status === 'ready')) {
      // Источник есть, но играть нельзя: нет связи, а на устройство трек не скачан.
      cancel();
      toast.info(t('offline.hint.notDownloaded'), { id: PLAY_TOAST_ID });
      return;
    }
    stopWatching();
    store.setState({ pending: { request, searched: own?.status === 'adding', seen: !!own, stale: null, trackId: null } });
    watch();
    // Toast не висит всё ожидание (поиск источника может занять минуты): дальше о нём говорит спиннер в строке.
    toast.loading(t('play.waiting', { title: request.title }), {
      action: { label: t('common.cancel'), onClick: cancel },
      duration: WAITING_TOAST_MS,
      id: PLAY_TOAST_ID,
    });
    deps.request(playInput(request)).then(
      res => {
        const now = store.getState().pending;
        if (now?.request !== request) return;
        // У «Слушать альбом» первый в треклисте — тот, что играет.
        const trackId = res.track_ids[0];
        if (trackId === undefined) {
          noSource(now);
          return;
        }
        const server = res.tracks.find(x => x.id === trackId)?.status;
        if (server === 'not_found') {
          noSource(now);
          return;
        }
        // `adding` от сервера: поиск начат после нажатия, любой последующий `not_found` в store — итог.
        const view = deps.findTrack({ ...now.request, trackId });
        const stale = server === 'adding' && view?.status === 'not_found' ? view : null;
        store.setState({ pending: { ...now, searched: now.searched || server === 'adding', stale, trackId } });
        startPolling();
        check();
      },
      (error: unknown) => {
        if (store.getState().pending?.request !== request) return;
        clear();
        toast.error(apiErrorMessage(error, t), { id: PLAY_TOAST_ID });
      },
    );
  }

  return { cancel, check, playRemote, store };
}

export type PlayRemote = ReturnType<typeof createPlayRemote>;

function appDeps(): PlayRemoteDeps {
  return {
    albumTracks: albumId => {
      const { library, selectors } = appData();
      return selectors.albumTracks(library.getState(), albumId);
    },
    canPlay,
    currentTrackId: () => currentTrack(player().store.getState())?.id ?? null,
    findTrack: ({ mbid, albumMbid, trackId }) => {
      const { library, selectors } = appData();
      const state = library.getState();
      if (trackId !== undefined) return selectors.trackView(state, trackId);
      if (albumMbid) {
        for (const album of state.albums.values()) {
          if (album.mbid !== albumMbid) continue;
          return selectors.albumTracks(state, album.id).find(v => v.mbid_recording === mbid);
        }
        return undefined;
      }
      // Без альбома: копия из библиотеки, иначе любая (её уже просили сыграть).
      const own = selectors.mbidIndex(state).tracks.get(mbid);
      if (own) return selectors.trackView(state, own.id);
      for (const t of state.tracks.values()) if (t.mbid_recording === mbid) return selectors.trackView(state, t.id);
      return undefined;
    },
    play: (track, queue) => player().play(track, queue),
    fetchStatus: async id => (await getTrack(id)).status,
    request: input => requestPlay(input),
    requestSync: () => appData().engine.requestSync('play-pending'),
    subscribeLibrary: listener => appData().library.subscribe(listener),
    subscribePlayer: listener => player().store.subscribe(listener),
  };
}

let instance: PlayRemote | null = null;

/** Экземпляр приложения (создаётся при первом обращении). */
export function playRemoteApp(): PlayRemote {
  instance ??= createPlayRemote(appDeps());
  return instance;
}

/** Этот трек (MBID записи) ждёт источника, чтобы заиграть. */
export function usePlayPending(mbid: string): boolean {
  return useStore(playRemoteApp().store, s => s.pending?.request.mbid === mbid);
}
