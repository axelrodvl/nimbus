import { toast } from 'sonner';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { appData } from '@/lib/app-data';
import type { TFn } from '@/lib/i18n/messages';
import { currentTrack } from '@/lib/player/engine';
import { player } from '@/lib/player/index';
import { canPlay, toPlayerTrack, type PlayerTrack } from '@/lib/player/track';
import type { TrackView } from '@/lib/store/selectors';
import { addToLibrary, type AddRequest } from './add';

/** Трек из MusicBrainz (поиск, каталог), который нужно сыграть, — возможно, его ещё нет в библиотеке. */
export type PlayRemoteRequest = {
  /** MBID записи (recording). */
  mbid: string;
  /** Альбом (release group), в составе которого добавить трек. */
  albumMbid: string | null;
  title: string;
  artistName?: string | null;
  cover?: string | null;
  /** `album` — очередь из доступных треков его альбома (экран альбома); иначе — только он. */
  context?: 'single' | 'album';
  /** Добавить альбом целиком, а не только трек («Слушать» у альбома из каталога). */
  addAlbum?: boolean;
  /** Точный трек библиотеки (локальный результат поиска): одна запись бывает в нескольких альбомах. */
  trackId?: number;
};

type State = { pending: PlayRemoteRequest | null };

export type PlayRemoteDeps = {
  /**
   * Трек библиотеки для запроса: по `trackId`; иначе запись в составе `albumMbid`; без альбома — любая копия записи.
   */
  findTrack: (request: Pick<PlayRemoteRequest, 'mbid' | 'albumMbid' | 'trackId'>) => TrackView | undefined;
  albumTracks: (albumId: number) => TrackView[];
  canPlay: (track: TrackView) => boolean;
  play: (track: PlayerTrack, queue: PlayerTrack[]) => void;
  add: (request: AddRequest, t: TFn) => Promise<boolean>;
  subscribeLibrary: (listener: () => void) => () => void;
  /** id текущего трека плеера и подписка на его смену. */
  currentTrackId: () => number | null;
  subscribePlayer: (listener: () => void) => () => void;
};

/** Toast ожидания один на всё приложение: новый запуск заменяет прежний. */
export const PLAY_TOAST_ID = 'play-remote';
/** Сколько висит toast ожидания. */
export const WAITING_TOAST_MS = 8000;

/**
 * «Нажал на трек — он играет», даже если трека нет в библиотеке: трек добавляется, а запуск ждёт, пока библиотека
 * не скажет, что у него есть источник (`found`). Ожидание одно: новый запуск заменяет прежний, повторное нажатие на тот
 * же трек — отменяет; пользователь включил что-то другое в плеере — ожидание снимается (иначе трек внезапно заиграл бы
 * поверх). Источник не найден — toast.
 */
export function createPlayRemote(deps: PlayRemoteDeps) {
  const store = createStore<State>(() => ({ pending: null }));
  let unsubscribe: (() => void) | null = null;
  let tRef: TFn | null = null;
  // Текущий трек плеера в момент постановки ожидания: смена на любой другой — отмена.
  let playerAtStart: number | null = null;

  function stopWatching() {
    unsubscribe?.();
    unsubscribe = null;
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
            .filter(v => v.id === view.id || (v.in_library && deps.canPlay(v)))
            .map(toPlayerTrack)
        : [track];
    deps.play(track, queue);
  }

  /**
   * Проверить ожидание: трек появился и готов — играть; источник не найден — сообщить. Источник есть, но играть нельзя
   * (нет связи, а на устройство трек не скачан) — тоже сообщить, а не крутить спиннер без конца.
   */
  function check() {
    const pending = store.getState().pending;
    if (!pending) return;
    const view = deps.findTrack(pending);
    if (!view) return;
    if (deps.canPlay(view)) {
      clear();
      toast.dismiss(PLAY_TOAST_ID);
      start(view, pending);
      return;
    }
    if (view.status === 'adding' || !tRef) return;
    clear();
    if (view.status === 'not_found') {
      toast.error(tRef('play.noSource', { title: pending.title }), { id: PLAY_TOAST_ID });
    } else {
      toast.info(tRef('offline.hint.notDownloaded'), { id: PLAY_TOAST_ID });
    }
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
   * Сыграть трек. Уже в библиотеке и доступен — сразу (в цепочке клика: iOS требует жеста для звука). Иначе —
   * добавить (если ещё не добавлен) и ждать источника; toast «Ищем источник…» с кнопкой «Отмена».
   */
  function playRemote(request: PlayRemoteRequest, t: TFn): void {
    tRef = t;
    // Повторное нажатие на то же (трек или «Слушать альбом»), что ждёт источника, — передумал: ожидание снимается.
    const pending = store.getState().pending;
    if (pending && pending.mbid === request.mbid && !!pending.addAlbum === !!request.addAlbum) {
      cancel();
      return;
    }
    const add: AddRequest =
      request.addAlbum && request.albumMbid
        ? {
            mbid: request.albumMbid,
            preview: { artistName: request.artistName, cover: request.cover, title: request.title },
            type: 'album',
          }
        : {
            albumMbid: request.albumMbid,
            mbid: request.mbid,
            preview: { artistName: request.artistName, cover: request.cover, title: request.title },
            type: 'track',
          };
    const own = deps.findTrack(request);
    if (own && deps.canPlay(own)) {
      cancel();
      start(own, request);
      // «Слушать альбом», которого нет в библиотеке, а первый трек в ней уже есть: альбом всё равно добавляется.
      if (add.type === 'album') void deps.add(add, t);
      return;
    }
    stopWatching();
    store.setState({ pending: request });
    watch();
    // Toast не висит всё ожидание (поиск источника может занять минуты): дальше о нём говорит спиннер в строке.
    toast.loading(t('play.waiting', { title: request.title }), {
      action: { label: t('common.cancel'), onClick: cancel },
      duration: WAITING_TOAST_MS,
      id: PLAY_TOAST_ID,
    });
    if (own && add.type === 'track') {
      // Уже в библиотеке, но играть нельзя: не найден или нет связи — сообщить сразу; ищется — ждать.
      check();
      return;
    }
    void deps.add(add, t).then(ok => {
      // Добавить не удалось (ошибку уже показал toast добавления) — ждать нечего.
      if (!ok && store.getState().pending === request) {
        clear();
        toast.dismiss(PLAY_TOAST_ID);
      }
      // Добавление ничего не изменило (альбом уже добавлялся) — трек мог уже быть в store.
      else check();
    });
  }

  return { cancel, check, playRemote, store };
}

export type PlayRemote = ReturnType<typeof createPlayRemote>;

function appDeps(): PlayRemoteDeps {
  return {
    add: (request, t) => addToLibrary(request, t, undefined, { quiet: true }),
    albumTracks: albumId => {
      const { library, selectors } = appData();
      return selectors.albumTracks(library.getState(), albumId);
    },
    canPlay,
    currentTrackId: () => currentTrack(player().store.getState())?.id ?? null,
    findTrack: ({ mbid, albumMbid, trackId }) => {
      const { library, selectors } = appData();
      const state = library.getState();
      const inLibrary = (v: TrackView | undefined) => (v?.in_library ? v : undefined);
      if (trackId !== undefined) return inLibrary(selectors.trackView(state, trackId));
      if (albumMbid) {
        for (const album of state.albums.values()) {
          if (album.mbid !== albumMbid) continue;
          return selectors.albumTracks(state, album.id).find(v => v.in_library && v.mbid_recording === mbid);
        }
        return undefined;
      }
      const own = selectors.mbidIndex(state).tracks.get(mbid);
      return own ? selectors.trackView(state, own.id) : undefined;
    },
    play: (track, queue) => player().play(track, queue),
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
  return useStore(playRemoteApp().store, s => s.pending?.mbid === mbid);
}
