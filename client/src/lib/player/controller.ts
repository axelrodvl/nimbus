// Контроллер плеера: не React. Владеет store состояния (`PlayerState`) и работает со звуком только через `AudioEngine`.
// Перенесено из `web/providers/player-provider.tsx` вместе с накопленными там исправлениями (гонки при быстром
// переключении, устаревшие события предыдущего трека, iOS: `play()` в цепочке жеста).
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AudioEngine, AudioEvent, AudioPosition, AudioSource } from './audio/types';
import {
  advanceListen,
  applyShuffle,
  currentTrack,
  initialState,
  nextPlayableIndex,
  parseStored,
  playerReducer,
  PREVIOUS_RESTART_THRESHOLD_S,
  prevPlayableIndex,
  serializeState,
  shuffleAround,
  STORAGE_KEY,
  type Listen,
  type PlayerAction,
  type PlayerError,
  type PlayerState,
  type RepeatMode,
} from './engine';
import { canPlay, isTranscoded, type PlayerTrack } from './track';

/** Интервал опроса позиции: учёт прослушивания, предзагрузка, сохранение. */
export const TICK_MS = 250;
/** Как часто позиция пишется в `localStorage` во время воспроизведения. */
export const PERSIST_INTERVAL_MS = 2000;
/** Через сколько после ошибки потока играет следующий трек. */
export const ERROR_ADVANCE_MS = 2000;
/** Как часто повторяется запуск трека недокачанного CUE-образа (событие `ready` могло потеряться). */
export const IMAGE_RETRY_MS = 30_000;
/** За сколько секунд до конца трека предзагружается следующий (если не включено «предзагружать сразу»). */
export const PREFETCH_BEFORE_END_S = 30;
/** Шаг перемотки стрелками и по `seekforward`/`seekbackward`. */
export const SEEK_STEP_S = 5;
/**
 * Перемотка перекодируемого трека — новый запрос потока (`?t=`): пока ползунок тянут, запросы объединяются,
 * новый поток открывается по паузе в движении.
 */
export const TRANSCODE_SEEK_DEBOUNCE_MS = 200;

export type PlayerStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type PlayerDeps = {
  engine: AudioEngine;
  /** Единственное место, где строится источник потока. Для сетевого трека возвращает значение синхронно (жест iOS). */
  resolveStreamUrl(track: PlayerTrack, startSeconds: number): AudioSource | Promise<AudioSource>;
  /** Актуальные данные трека из библиотечного store; `undefined` — трека там больше нет. */
  getTrack(id: number): PlayerTrack | undefined;
  /** Библиотека загружена из IndexedDB: до этого снимкам треков в очереди верим как есть. */
  libraryReady(): boolean;
  /** Подписка на изменения библиотеки (статусы треков). */
  subscribeLibrary?(listener: () => void): () => void;
  /** Расшифровка отказа потока (`HEAD` к источнику). */
  probe(src: AudioSource): Promise<PlayerError>;
  /** Засчитать прослушивание (через outbox шага 37: без сети уходит позже). */
  recordPlay(trackId: number): Promise<unknown>;
  /** Включена ли предзагрузка следующего трека сразу (настройка `playback.prefetch_next`). */
  prefetchEnabled(): boolean;
  prefetchTrack(trackId: number): Promise<unknown>;
  /** Показать пользователю ошибку воспроизведения. */
  notifyError?(track: PlayerTrack, error: PlayerError): void;
  /** Скачан ли трек на устройство: такой трек играет как обычный файл (`direct`), даже если на сервере он перекодируется. */
  isOffline?(trackId: number): boolean;
  /** Подготовить источник скачанного трека заранее (к клику он уже готов — жест iOS). */
  prepareOffline?(trackId: number): void;
  /** Файл скачанного трека не воспроизвёлся: пометить повреждённым (трек вернётся в очередь скачивания). */
  offlineBroken?(trackId: number): void;
  storage?: PlayerStorage;
  now?: () => number;
};

const noop = () => undefined;
const isPromise = <T>(v: T | Promise<T>): v is Promise<T> => typeof (v as Promise<T>)?.then === 'function';

export class PlayerController {
  readonly engine: AudioEngine;
  /** Состояние плеера. Текущая позиция сюда не пишется каждый тик — см. `positionNow()` и `useProgress`. */
  readonly store: StoreApi<PlayerState>;

  private readonly deps: PlayerDeps;
  private readonly storage: PlayerStorage | undefined;
  private readonly now: () => number;
  /** Трек, загруженный в движок (после отмены/восстановления — null). */
  private loadedId: number | null = null;
  private source: AudioSource | null = null;
  /** Загруженный трек играет из файла на устройстве (а не из сети): ошибка тогда означает повреждённый файл. */
  private sourceIsOffline = false;
  /** Номер последней загрузки: ответ устаревшего асинхронного `resolveStreamUrl` отбрасывается. */
  private loadSeq = 0;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  /** С какой секунды запрошен текущий поток (`startAt` последней загрузки). */
  private loadStart = 0;
  /** Запускалась ли последняя загрузка с воспроизведением (ожидание образа продолжит так же). */
  private loadAutoplay = true;
  /**
   * Перемотка перекодируемого трека открыла новый поток: если сервер ответит `425 image_downloading`, возвращаемся
   * на начало прежнего потока (он был получен успешно) и сообщаем, что перемотка пока недоступна.
   */
  private revert: { at: number; playing: boolean } | null = null;
  /** Начало потока, который играл до перемотки (смещение `?t=` последней успешной загрузки). */
  private streamOffset = 0;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
  /** Цель отложенной перемотки перекодируемого трека: до открытия нового потока позиция показывается по ней. */
  private pendingSeek: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private lastPersist = 0;
  private listen: Listen | null = null;
  private prefetched: number | null = null;
  /** Трек, отданный движку как «следующий» (для `advanced` и чтобы не повторять `preloadNext`). */
  private preloadedId: number | null = null;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(deps: PlayerDeps) {
    this.deps = deps;
    this.engine = deps.engine;
    this.storage = deps.storage;
    this.now = deps.now ?? Date.now;
    this.store = createStore<PlayerState>(() => initialState);
    this.unsubscribers.push(this.engine.on(e => this.onEngineEvent(e)));
    this.restore();
    this.unsubscribers.push(this.store.subscribe((s, prev) => this.onState(s, prev)));
    const sub = deps.subscribeLibrary?.(() => this.onLibraryChanged());
    if (sub) this.unsubscribers.push(sub);
  }

  // ------------------------------------------------------------------ состояние

  get state(): PlayerState {
    return this.store.getState();
  }

  private dispatch(action: PlayerAction) {
    this.store.setState(playerReducer(this.state, action), true);
  }

  /** Текущая позиция в секундах (читается у движка: в store она во время воспроизведения не обновляется). */
  positionNow = (): number => this.getPosition().current;

  /**
   * Позиция для показа: у движка, пока трек загружен; иначе (после перезапуска, отмены) — сохранённая в состоянии
   * позиция, с которой продолжится воспроизведение.
   */
  getPosition = (): AudioPosition => {
    if (this.loadedId === null) return { buffered: [], current: this.state.position, duration: this.state.duration };
    const pos = this.engine.getPosition();
    return this.pendingSeek === null ? pos : { ...pos, current: this.pendingSeek };
  };

  /** Актуальный трек: из библиотеки; `null` — удалён. До загрузки библиотеки — снимок из очереди. */
  private live(track: PlayerTrack): PlayerTrack | null {
    if (!this.deps.libraryReady()) return track;
    return this.deps.getTrack(track.id) ?? null;
  }

  /** Можно ли играть трек очереди прямо сейчас (удалённые и недоступные — нет). */
  canPlayQueued = (track: PlayerTrack): boolean => {
    const live = this.live(track);
    return live !== null && canPlay(live);
  };

  /** Перекодируемый поток (перемотка через `?t=`) — только для сетевого трека; скачанный файл играет как `direct`. */
  private transcoded(track: PlayerTrack): boolean {
    return isTranscoded(track) && !this.deps.isOffline?.(track.id);
  }

  hasNext = (s: PlayerState = this.state): boolean =>
    nextPlayableIndex(s.queue, s.index, this.canPlayQueued, s.repeat === 'all') >= 0;

  // ------------------------------------------------------------------ загрузка и запуск

  private loadAndPlay(
    track: PlayerTrack,
    startAt = 0,
    autoplay = true,
    revert: { at: number; playing: boolean } | null = null,
  ) {
    clearTimeout(this.errorTimer);
    this.cancelPendingSeek();
    this.loadStart = startAt;
    this.loadAutoplay = autoplay;
    this.revert = revert;
    const fresh = this.live(track) ?? track;
    const viaOffline = this.deps.isOffline?.(track.id) === true;
    const transcoded = this.transcoded(fresh);
    const offset = transcoded ? startAt : 0;
    if (!revert) this.streamOffset = offset;
    const seq = ++this.loadSeq;
    this.loadedId = track.id;
    this.source = null;
    const go = (src: AudioSource) => {
      if (seq !== this.loadSeq) return;
      this.source = src;
      this.sourceIsOffline = viaOffline;
      this.engine.setNowPlaying({
        album: fresh.album ?? '',
        artist: fresh.artist,
        coverUrl: fresh.coverUrl,
        durationS: fresh.durationMs ? fresh.durationMs / 1000 : 0,
        title: fresh.title,
      });
      this.engine.load(src, { autoplay, positionOffset: offset, startAt: transcoded ? 0 : startAt });
      // Новая загрузка сбрасывает очередь нативного плеера — «следующий» отдаём заново.
      this.preloadedId = null;
      this.syncNext();
    };
    let resolved: AudioSource | Promise<AudioSource>;
    try {
      resolved = this.deps.resolveStreamUrl(fresh, offset);
    } catch {
      this.failResolve(track, seq);
      return;
    }
    // Значение, полученное синхронно, не ждём: `engine.load` должен выполниться в цепочке клика (iOS).
    if (isPromise(resolved)) resolved.then(go, () => this.failResolve(track, seq));
    else go(resolved);
  }

  private cancelPendingSeek() {
    clearTimeout(this.seekTimer);
    this.pendingSeek = null;
  }

  private failResolve(track: PlayerTrack, seq: number) {
    if (seq !== this.loadSeq) return;
    this.loadedId = null;
    this.showError(track, { code: 'network' }, false);
  }

  private playIndexInternal(index: number) {
    const track = this.state.queue[index];
    if (!track) return;
    this.dispatch({ index, type: 'GOTO' });
    this.listen = null;
    this.prefetched = null;
    this.loadAndPlay(track);
  }

  playIndex = (index: number) => this.playIndexInternal(index);

  /** Играть `track`; очередь — `queue` (с этого трека). С включённым shuffle текущий трек становится первым. */
  play = (track: PlayerTrack, queue?: PlayerTrack[]) => {
    let q = queue?.length ? queue : [track];
    let index = q.findIndex(x => x.id === track.id);
    if (index < 0) {
      q = [track, ...q];
      index = 0;
    }
    if (this.state.shuffle) {
      this.dispatch({ index: 0, originalQueue: q, queue: shuffleAround(q, index), type: 'LOAD' });
    } else {
      this.dispatch({ index, originalQueue: null, queue: q, type: 'LOAD' });
    }
    this.listen = null;
    this.prefetched = null;
    this.loadAndPlay(track);
  };

  next = () => {
    const { queue, index, repeat } = this.state;
    const j = nextPlayableIndex(queue, index, this.canPlayQueued, repeat === 'all');
    if (j >= 0) this.playIndexInternal(j);
  };

  previous = () => {
    const { queue, index, repeat } = this.state;
    const j = prevPlayableIndex(queue, index, this.canPlayQueued, repeat === 'all');
    if (this.positionNow() > PREVIOUS_RESTART_THRESHOLD_S || j < 0) this.seekTo(0);
    else this.playIndexInternal(j);
  };

  pause = () => {
    this.engine.pause();
  };

  resume = () => {
    const track = currentTrack(this.state);
    if (!track) return;
    if (this.loadedId !== track.id) {
      // Восстановленная или отменённая очередь: движок ещё пуст.
      const position = this.state.position;
      this.dispatch({ index: this.state.index, type: 'GOTO' });
      this.dispatch({ position, type: 'TICK' });
      this.startCurrent(track, position);
      return;
    }
    this.dispatch({ type: 'PLAYING', value: true });
    this.engine.play().catch(() => this.dispatch({ type: 'PLAYING', value: false }));
  };

  togglePlayPause = () => {
    if (this.state.isPlaying) this.pause();
    else this.resume();
  };

  /** Запуск текущего трека; если он ещё не готов к воспроизведению — ждём, пока библиотека скажет `found`. */
  private startCurrent(track: PlayerTrack, position: number) {
    if (!this.canPlayQueued(track)) {
      this.loadedId = null;
      this.dispatch({ error: { code: 'track_not_playable' }, status: 'error', type: 'STATUS' });
      return;
    }
    this.loadAndPlay(track, position);
  }

  /** В жесте пользователя: подготовить движок к отложенному старту (если он это умеет). */
  prime = () => this.engine.prime?.();

  /** Отменить загрузку/ожидание раздачи: источник сбрасывается, очередь остаётся. */
  cancel = () => {
    clearTimeout(this.errorTimer);
    this.cancelPendingSeek();
    this.loadSeq++;
    this.engine.unload();
    this.engine.setNowPlaying(null);
    this.loadedId = null;
    this.source = null;
    this.sourceIsOffline = false;
    this.preloadedId = null;
    this.dispatch({ type: 'CANCEL' });
  };

  seekTo = (seconds: number) => {
    const { duration } = this.state;
    const t = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    const track = currentTrack(this.state);
    if (track && this.loadedId === track.id && this.transcoded(this.live(track) ?? track)) {
      // Новый запрос `?t=` вместо перемотки (запросы при перетаскивании объединяются); играем, если играли.
      clearTimeout(this.seekTimer);
      this.pendingSeek = t;
      this.seekTimer = setTimeout(() => {
        if (this.loadedId !== track.id) return;
        const playing = this.state.isPlaying;
        this.loadAndPlay(track, t, playing, { at: this.streamOffset, playing });
      }, TRANSCODE_SEEK_DEBOUNCE_MS);
    } else if (this.loadedId !== null) {
      this.engine.seek(t);
    }
    this.dispatch({ position: t, type: 'TICK' });
  };

  /**
   * Источник трека сменили вручную: если он загружен в плеер, поток открывается заново с текущей позиции
   * (пауза остаётся паузой). Другие треки не затрагиваются.
   */
  reloadTrack = (id: number) => {
    const track = currentTrack(this.state);
    if (!track || track.id !== id || this.loadedId !== id) return;
    this.loadAndPlay(track, this.positionNow(), this.state.isPlaying);
  };

  setVolume = (v: number) => {
    const volume = Math.min(100, Math.max(0, v));
    this.dispatch({ type: 'VOLUME', volume });
    if (volume > 0 && this.state.muted) this.toggleMute();
    else this.applyVolume();
  };

  toggleMute = () => {
    this.dispatch({ muted: !this.state.muted, type: 'MUTED' });
    this.applyVolume();
  };

  private applyVolume() {
    const { volume, muted } = this.state;
    this.engine.setVolume(muted ? 0 : volume / 100);
  }

  toggleShuffle = () => {
    const s = this.state;
    const on = !s.shuffle;
    this.dispatch({ shuffle: on, type: 'SHUFFLE', ...applyShuffle(s, on) });
  };

  cycleRepeat = () => {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    this.dispatch({ repeat: order[(order.indexOf(this.state.repeat) + 1) % order.length], type: 'REPEAT' });
  };

  enqueue = (track: PlayerTrack) => this.dispatch({ track, type: 'ENQUEUE' });
  playNext = (track: PlayerTrack) => this.dispatch({ track, type: 'PLAY_NEXT' });
  removeFromQueue = (index: number) => this.dispatch({ index, type: 'REMOVE' });
  /** Переставляет трек очереди (только среди следующих за текущим). */
  moveInQueue = (from: number, to: number) => this.dispatch({ from, to, type: 'MOVE' });

  // ------------------------------------------------------------------ события движка

  private onEngineEvent(e: AudioEvent) {
    switch (e.type) {
      case 'loading':
        if (this.loadedId !== null) this.setStatus('loading');
        break;
      case 'playing':
        if (this.loadedId === null) break;
        this.setStatus('playing');
        this.dispatch({ type: 'PLAYING', value: true });
        break;
      case 'waiting':
        if (this.loadedId !== null) this.setStatus('buffering');
        break;
      case 'paused': {
        if (this.loadedId === null) break;
        // Пауза не от пользователя (звонок, Siri, наушники): очередь не трогаем, `play` с гарнитуры продолжит.
        this.dispatch(e.interrupted ? { type: 'INTERRUPTED' } : { type: 'PLAYING', value: false });
        const { status } = this.state;
        if (status !== 'error' && status !== 'idle') this.setStatus('paused');
        break;
      }
      case 'ended':
        // Трек доигран (в т. ч. при повторе одного трека) — следующий проход считается заново.
        this.listen = null;
        this.onEnded();
        break;
      case 'error':
        this.onError();
        break;
      case 'advanced':
        this.onAdvanced();
        break;
      case 'remote':
        this.onRemote(e);
        break;
    }
  }

  private setStatus(status: PlayerState['status']) {
    if (this.state.status !== status) this.dispatch({ status, type: 'STATUS' });
  }

  private onEnded() {
    const track = currentTrack(this.state);
    if (!track) return;
    const restart = () => {
      if (this.transcoded(this.live(track) ?? track)) this.loadAndPlay(track, 0);
      else {
        this.engine.seek(0);
        this.engine.play().catch(noop);
      }
    };
    const { queue, index, repeat } = this.state;
    if (repeat === 'one') {
      restart();
      return;
    }
    const j = nextPlayableIndex(queue, index, this.canPlayQueued, repeat === 'all');
    if (j === index) restart();
    else if (j >= 0) this.playIndexInternal(j);
    else this.dispatch({ type: 'STOP' });
  }

  private onError() {
    const track = currentTrack(this.state);
    const src = this.source;
    // Пустой источник (после отмены) и чужой трек — не ошибка.
    if (!track || !src || this.loadedId !== track.id) return;
    // Скачанный файл не воспроизвёлся (повреждён): помечаем, и трек играет по сети с того же места.
    if (this.sourceIsOffline && this.deps.offlineBroken) {
      this.deps.offlineBroken(track.id);
      this.loadAndPlay(track, this.positionNow(), this.state.isPlaying);
      return;
    }
    const seq = this.loadSeq;
    void this.deps.probe(src).then(err => {
      // Пока шла расшифровка, трек могли загрузить заново (в т. ч. тот же): ошибка относится к старой загрузке.
      if (seq !== this.loadSeq) return;
      if (err.code === 'image_downloading') this.onImageDownloading(track);
      else this.showError(track, err, true);
    });
  }

  /**
   * Трек CUE-образа, который ещё докачивается (`425`): это ожидание, а не ошибка — очередь не двигается. После
   * перемотки возвращаемся на прежний поток; иначе ждём, пока трек станет `ready` (или повторяем раз в 30 с).
   */
  private onImageDownloading(track: PlayerTrack) {
    const revert = this.revert;
    this.revert = null;
    if (revert) {
      this.loadAndPlay(track, revert.at, revert.playing);
      this.deps.notifyError?.(track, { code: 'seek_unavailable' });
      return;
    }
    this.loadSeq++;
    this.loadedId = null;
    this.source = null;
    this.dispatch({ position: this.loadStart, type: 'TICK' });
    this.dispatch({ error: { code: 'image_downloading' }, status: 'error', type: 'STATUS' });
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.retryImage(track.id), IMAGE_RETRY_MS);
  }

  private waitingForImage(track: PlayerTrack): boolean {
    const s = this.state;
    return (
      currentTrack(s)?.id === track.id &&
      s.status === 'error' &&
      s.error?.code === 'image_downloading' &&
      this.loadedId === null
    );
  }

  private retryImage(id: number) {
    const track = currentTrack(this.state);
    if (!track || track.id !== id || !this.waitingForImage(track)) return;
    this.setStatus('loading');
    this.loadAndPlay(track, this.state.position, this.loadAutoplay);
  }

  private showError(track: PlayerTrack, error: PlayerError, advance: boolean) {
    this.dispatch({ error, status: 'error', type: 'STATUS' });
    this.dispatch({ type: 'PLAYING', value: false });
    this.deps.notifyError?.(track, error);
    if (!advance) return;
    // Через 2 с — к следующему играбельному треку (без зацикливания).
    this.errorTimer = setTimeout(() => {
      const s = this.state;
      if (currentTrack(s)?.id !== track.id || s.status !== 'error') return;
      const j = nextPlayableIndex(s.queue, s.index, this.canPlayQueued, false);
      if (j >= 0) this.playIndexInternal(j);
    }, ERROR_ADVANCE_MS);
  }

  /** Нативный движок сам перешёл к предзагруженному треку: двигаем очередь, не запуская трек повторно. */
  private onAdvanced() {
    const { queue, index, repeat } = this.state;
    const j = nextPlayableIndex(queue, index, this.canPlayQueued, repeat === 'all');
    const track = queue[j];
    if (!track) return;
    this.loadSeq++;
    this.dispatch({ index: j, type: 'GOTO' });
    this.loadedId = track.id;
    this.listen = null;
    this.preloadedId = null;
    this.syncNext();
  }

  /** Команды экрана блокировки, гарнитуры и медиаклавиш — те же функции, что и у кнопок интерфейса. */
  private onRemote(e: Extract<AudioEvent, { type: 'remote' }>) {
    switch (e.action) {
      case 'play':
        this.resume();
        break;
      case 'pause':
        this.pause();
        break;
      case 'next':
        this.next();
        break;
      case 'previous':
        this.previous();
        break;
      case 'seekto':
        if (e.seekTo !== undefined) this.seekTo(e.seekTo);
        break;
      case 'seekbackward':
        this.seekTo(this.positionNow() - (e.offset ?? SEEK_STEP_S));
        break;
      case 'seekforward':
        this.seekTo(this.positionNow() + (e.offset ?? SEEK_STEP_S));
        break;
    }
  }

  // ------------------------------------------------------------------ библиотека

  private onLibraryChanged() {
    const s = this.state;
    const track = currentTrack(s);
    // Трек ждал источника и стал `found` — продолжаем.
    if (
      track &&
      s.status === 'error' &&
      s.error?.code === 'track_not_playable' &&
      s.isPlaying &&
      this.loadedId === null
    ) {
      if (this.canPlayQueued(track)) {
        this.setStatus('loading');
        this.loadAndPlay(track, s.position);
      }
    }
    // Трек недокачанного образа стал `ready` — продолжаем с того же места.
    if (track && this.waitingForImage(track) && this.live(track)?.status === 'ready') this.retryImage(track.id);
    this.syncNext();
  }

  /** Сообщает движку актуальный «следующий» трек (ставший недоступным пропускается — выбор идёт заново). */
  private syncNext() {
    const s = this.state;
    if (this.loadedId === null) return;
    const j = nextPlayableIndex(s.queue, s.index, this.canPlayQueued, s.repeat === 'all');
    const next = j >= 0 && j !== s.index ? s.queue[j] : undefined;
    const id = next?.id ?? null;
    if (id === this.preloadedId) return;
    this.preloadedId = id;
    if (!next) {
      this.engine.preloadNext(null);
      return;
    }
    this.deps.prepareOffline?.(next.id);
    try {
      const src = this.deps.resolveStreamUrl(this.live(next) ?? next, 0);
      if (isPromise(src)) {
        void src.then(v => {
          if (this.preloadedId === id) this.engine.preloadNext(v);
        }, noop);
      } else this.engine.preloadNext(src);
    } catch {
      // Источник следующего трека не построился — предзагрузки не будет.
    }
  }

  // ------------------------------------------------------------------ опрос позиции и сохранение

  private onState(s: PlayerState, prev: PlayerState) {
    if (s.isPlaying && !this.tickTimer) this.tickTimer = setInterval(this.tick, TICK_MS);
    else if (!s.isPlaying && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    // Очередь, настройки и пауза сохраняются сразу; позиция во время игры — раз в 2 с (`tick`).
    if (
      s.queue !== prev.queue ||
      s.index !== prev.index ||
      s.volume !== prev.volume ||
      s.muted !== prev.muted ||
      s.shuffle !== prev.shuffle ||
      s.repeat !== prev.repeat ||
      (prev.isPlaying && !s.isPlaying)
    ) {
      this.persist();
    }
    if (s.queue !== prev.queue || s.index !== prev.index || s.repeat !== prev.repeat) {
      this.prepareCurrent();
      this.syncNext();
    }
  }

  /** Источник скачанного текущего трека готовится заранее: `play()` в цепочке жеста получит его синхронно. */
  private prepareCurrent() {
    const current = currentTrack(this.state);
    if (current) this.deps.prepareOffline?.(current.id);
  }

  /** Раз в `TICK_MS` при воспроизведении: длительность, учёт прослушивания, предзагрузка, сохранение. */
  tick = () => {
    const s = this.state;
    const track = currentTrack(s);
    if (!track || this.loadedId !== track.id) return;
    const pos = this.engine.getPosition();
    if (pos.duration > 0 && Math.abs(pos.duration - s.duration) > 0.01) {
      this.dispatch({ duration: pos.duration, position: s.position, type: 'TICK' });
    }
    if (s.isPlaying) {
      const duration = track.durationMs ? track.durationMs / 1000 : pos.duration;
      const { listen, count } = advanceListen(
        this.listen,
        track.id,
        pos.current,
        Number.isFinite(duration) ? duration : 0,
      );
      this.listen = listen;
      if (count) void this.deps.recordPlay(track.id).catch(noop);
      this.prefetchNext(pos.duration, pos.current);
    }
    if (this.now() - this.lastPersist >= PERSIST_INTERVAL_MS) this.persist();
  };

  /** Предзагрузка следующего трека: за 30 с до конца (или сразу, если включено `prefetch_next`); только для `found`. */
  private prefetchNext(duration: number, position: number) {
    if (!(duration > 0) || (!this.deps.prefetchEnabled() && duration - position > PREFETCH_BEFORE_END_S)) return;
    const { queue, index, repeat } = this.state;
    const j = nextPlayableIndex(queue, index, this.canPlayQueued, repeat === 'all');
    const next = j >= 0 && j !== index ? queue[j] : undefined;
    const live = next && this.live(next);
    // Только `found`: у `ready` файл уже на диске. Скачанный на устройство трек предзагружать на сервере незачем.
    if (!next || !live || live.status !== 'found' || this.prefetched === next.id) return;
    if (this.deps.isOffline?.(next.id)) return;
    this.prefetched = next.id;
    void this.deps.prefetchTrack(next.id).catch(noop);
  }

  /**
   * Вернулись из фона: сверяем состояние плеера с фактическим звуком (система могла приостановить или продолжить
   * воспроизведение без нас) и позицию. Не запускает и не останавливает звук.
   */
  reconcile = () => {
    const track = currentTrack(this.state);
    if (!track || this.loadedId !== track.id) return;
    const actual = this.engine.isPlaying();
    const s = this.state;
    if (s.isPlaying && !actual && s.status !== 'loading' && s.status !== 'buffering') {
      this.dispatch({ type: 'INTERRUPTED' });
      this.setStatus('paused');
    } else if (!s.isPlaying && actual) {
      this.dispatch({ type: 'PLAYING', value: true });
      this.setStatus('playing');
    }
    this.dispatch({ position: this.positionNow(), type: 'TICK' });
    this.tick();
  };

  /** Записывает состояние в хранилище; вызывается и при закрытии страницы (`pagehide`). */
  persist = () => {
    const s = this.state;
    this.lastPersist = this.now();
    if (!this.storage || (s.queue.length === 0 && s.volume === initialState.volume)) return;
    try {
      this.storage.setItem(STORAGE_KEY, serializeState(s, this.positionNow()));
    } catch {
      // Хранилище переполнено или запрещено.
    }
  };

  private restore() {
    let stored = null;
    try {
      stored = parseStored(this.storage?.getItem(STORAGE_KEY) ?? null);
    } catch {
      // Хранилище недоступно.
    }
    if (!stored) return;
    this.dispatch({ stored, type: 'RESTORE' });
    this.applyVolume();
  }

  /** Останавливает звук и таймеры (выход из аккаунта, тесты). Сохранённая очередь остаётся. */
  destroy() {
    clearTimeout(this.errorTimer);
    this.cancelPendingSeek();
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.loadSeq++;
    for (const off of this.unsubscribers.splice(0)) off();
    this.engine.unload();
    this.engine.setNowPlaying(null);
  }
}
