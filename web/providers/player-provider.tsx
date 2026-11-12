'use client';

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import { loadPrefetchEnabled, prefetchTrack } from '@/app/actions/settings';
import { useLiveEvent } from '@/hooks/use-live-events';
import { publicBackendUrl } from '@/lib/env';
import { useT } from '@/providers/i18n-provider';
import { useLiveLibrary } from '@/providers/live-library-provider';
import {
  applyShuffle,
  canPlayStatus,
  currentTrack,
  initialState,
  nextPlayableIndex,
  parseStored,
  playerReducer,
  PREVIOUS_RESTART_THRESHOLD_S,
  prevPlayableIndex,
  playerErrorText,
  probeStreamError,
  serializeState,
  shuffleAround,
  STORAGE_KEY,
  toRanges,
  type PlayerState,
  type RepeatMode,
} from '@/providers/player/engine';
import type { Track } from '@/types/track';

// Плеер: один HTMLAudioElement на приложение, источник — `${NEXT_PUBLIC_BACKEND_URL}/api/tracks/{id}/stream`.
// Публичный интерфейс `usePlayer()` совместим с версией-заглушкой (шаг 08): `progress` — 0–100, `volume` — 0–100.

export type PlayerContextValue = PlayerState & {
  track: Track | null;
  queueIndex: number;
  /** Позиция, 0–100 (проценты). */
  progress: number;
  hasQueue: boolean;
  hasNext: boolean;
  play: (track: Track, queue?: Track[]) => void;
  pause: () => void;
  resume: () => void;
  togglePlayPause: () => void;
  next: () => void;
  previous: () => void;
  /** Перемотка, 0–100 (проценты). */
  seek: (progress: number) => void;
  /** Перемотка в секундах. */
  seekTo: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  enqueue: (track: Track) => void;
  playNext: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  playIndex: (index: number) => void;
  /** Отменить загрузку/ожидание раздачи. */
  cancel: () => void;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

export const streamUrl = (trackId: number, startSeconds = 0) =>
  `${publicBackendUrl}/api/tracks/${trackId}/stream${startSeconds > 0 ? `?t=${startSeconds.toFixed(3)}` : ''}`;

const isTranscoded = (t: Track | null | undefined) => t?.playback === 'transcode';

const ERROR_ADVANCE_MS = 2000;
/** За сколько секунд до конца трека предзагружаем следующий. */
const PREFETCH_BEFORE_END_S = 30;
const TICK_THROTTLE_MS = 250;
const PERSIST_INTERVAL_MS = 2000;
const SEEK_STEP_S = 5;

// Элементы, в которых клавиши ←/→/пробел заняты самим элементом.
function isEditable(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
    t.getAttribute('role') === 'slider' ||
    t.getAttribute('role') === 'textbox'
  );
}

// Пробел на кнопке/ссылке — штатная активация этого элемента.
function activatesOnSpace(t: EventTarget | null) {
  return (
    t instanceof HTMLElement && (['BUTTON', 'A', 'SUMMARY'].includes(t.tagName) || t.getAttribute('role') === 'button')
  );
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const { trackStatus } = useLiveLibrary();
  const t = useT();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Трек, который сейчас загружен в элемент (после отмены/восстановления — null). */
  const loadedIdRef = useRef<number | null>(null);
  /** Позиция, к которой перейти после `loadedmetadata`. */
  const pendingSeekRef = useRef(0);
  /** Для перекодируемых треков (без Range): с какой секунды трека начался текущий поток. */
  const offsetRef = useRef(0);
  const positionOf = (audio: HTMLAudioElement) => offsetRef.current + audio.currentTime;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTickRef = useRef(0);
  const lastPositionStateRef = useRef(0);
  const latest = useRef({ state, t, trackStatus });
  const actionsRef = useRef<Actions | null>(null);

  useEffect(() => {
    latest.current = { state, t, trackStatus };
  });

  const positionNow = useCallback(
    () => (audioRef.current ? offsetRef.current + audioRef.current.currentTime : latest.current.state.position),
    [],
  );

  const canPlay = (t: Track) => canPlayStatus(latest.current.trackStatus.get(t.id)?.status ?? t.status);
  const canPlayNow = (t: Track) => canPlayStatus(trackStatus.get(t.id)?.status ?? t.status);

  function loadAndPlay(track: Track, startAt = 0, autoplay = true) {
    const audio = audioRef.current;
    if (!audio) return;
    clearTimeout(errorTimerRef.current);
    loadedIdRef.current = track.id;
    // Перекодируемый поток нельзя перематывать через `currentTime`: начинаем с нужной секунды новым запросом.
    offsetRef.current = isTranscoded(track) ? startAt : 0;
    pendingSeekRef.current = isTranscoded(track) ? 0 : startAt;
    audio.src = streamUrl(track.id, offsetRef.current);
    if (autoplay) {
      audio.play().catch((e: unknown) => {
        // AbortError — загрузку заменили другим треком; NotAllowedError — политика автозапуска.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        dispatch({ type: 'PLAYING', value: false });
        dispatch({ status: 'paused', type: 'STATUS' });
      });
    }
  }

  function playIndex(index: number) {
    const { queue } = latest.current.state;
    const t = queue[index];
    if (!t) return;
    dispatch({ index, type: 'GOTO' });
    loadAndPlay(t);
  }

  const actions = {
    cancel() {
      const audio = audioRef.current;
      if (!audio) return;
      clearTimeout(errorTimerRef.current);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loadedIdRef.current = null;
      pendingSeekRef.current = 0;
      offsetRef.current = 0;
      dispatch({ type: 'CANCEL' });
    },
    cycleRepeat() {
      const order: RepeatMode[] = ['off', 'all', 'one'];
      const cur = latest.current.state.repeat;
      dispatch({ repeat: order[(order.indexOf(cur) + 1) % order.length], type: 'REPEAT' });
    },
    enqueue(track: Track) {
      dispatch({ track, type: 'ENQUEUE' });
    },
    next() {
      const { queue, index, repeat } = latest.current.state;
      const j = nextPlayableIndex(queue, index, canPlay, repeat === 'all');
      if (j >= 0) playIndex(j);
    },
    onEnded() {
      const audio = audioRef.current;
      const restart = () => {
        const track = currentTrack(latest.current.state);
        if (track && isTranscoded(track)) loadAndPlay(track, 0);
        else if (audio) {
          audio.currentTime = 0;
          void audio.play();
        }
      };
      const { queue, index, repeat } = latest.current.state;
      if (!audio) return;
      if (repeat === 'one') {
        restart();
        return;
      }
      const j = nextPlayableIndex(queue, index, canPlay, repeat === 'all');
      if (j === index) {
        restart();
      } else if (j >= 0) playIndex(j);
      else dispatch({ type: 'STOP' });
    },
    onError() {
      const audio = audioRef.current;
      const track = currentTrack(latest.current.state);
      // Пустой src (после отмены) — не ошибка.
      if (!audio || !track || !audio.getAttribute('src') || loadedIdRef.current !== track.id) return;
      void probeStreamError(streamUrl(track.id)).then(err => {
        if (loadedIdRef.current !== track.id) return;
        dispatch({ error: err, status: 'error', type: 'STATUS' });
        dispatch({ type: 'PLAYING', value: false });
        toast.error(`${track.title}: ${playerErrorText(latest.current.t, err.code)}`);
        // Через 2 с — к следующему играбельному треку (без зацикливания).
        errorTimerRef.current = setTimeout(() => {
          const s = latest.current.state;
          if (currentTrack(s)?.id !== track.id || s.status !== 'error') return;
          const j = nextPlayableIndex(s.queue, s.index, canPlay, false);
          if (j >= 0) playIndex(j);
        }, ERROR_ADVANCE_MS);
      });
    },
    pause() {
      audioRef.current?.pause();
    },
    play(track: Track, queue?: Track[]) {
      let q = queue?.length ? queue : [track];
      let index = q.findIndex(x => x.id === track.id);
      if (index < 0) {
        q = [track, ...q];
        index = 0;
      }
      if (latest.current.state.shuffle) {
        dispatch({ index: 0, originalQueue: q, queue: shuffleAround(q, index), type: 'LOAD' });
      } else {
        dispatch({ index, originalQueue: null, queue: q, type: 'LOAD' });
      }
      loadAndPlay(track);
    },
    playIndex,
    playNext(track: Track) {
      dispatch({ track, type: 'PLAY_NEXT' });
    },
    previous() {
      const audio = audioRef.current;
      const { queue, index, repeat } = latest.current.state;
      if (!audio) return;
      const j = prevPlayableIndex(queue, index, canPlay, repeat === 'all');
      if (positionOf(audio) > PREVIOUS_RESTART_THRESHOLD_S || j < 0) actions.seekTo(0);
      else playIndex(j);
    },
    removeFromQueue(index: number) {
      dispatch({ index, type: 'REMOVE' });
    },
    resume() {
      const audio = audioRef.current;
      const track = currentTrack(latest.current.state);
      if (!audio || !track) return;
      if (loadedIdRef.current !== track.id) {
        // Восстановленная или отменённая очередь: элемент ещё пуст.
        dispatch({ index: latest.current.state.index, type: 'GOTO' });
        loadAndPlay(track, latest.current.state.position);
        return;
      }
      audio.play().catch(() => undefined);
    },
    seekTo(seconds: number) {
      const audio = audioRef.current;
      const { duration } = latest.current.state;
      const t = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
      const track = currentTrack(latest.current.state);
      if (audio && loadedIdRef.current !== null && track && isTranscoded(track)) {
        // Новый запрос `?t=` вместо `currentTime`; играем, если играли.
        loadAndPlay(track, t, latest.current.state.isPlaying);
      } else if (audio && loadedIdRef.current !== null) audio.currentTime = t;
      else pendingSeekRef.current = t;
      dispatch({ position: t, type: 'TICK' });
    },
    setVolume(v: number) {
      const volume = Math.min(100, Math.max(0, v));
      if (audioRef.current) audioRef.current.volume = volume / 100;
      dispatch({ type: 'VOLUME', volume });
      if (volume > 0 && latest.current.state.muted) actions.toggleMute();
    },
    toggleMute() {
      const muted = !latest.current.state.muted;
      if (audioRef.current) audioRef.current.muted = muted;
      dispatch({ muted, type: 'MUTED' });
    },
    toggleShuffle() {
      const s = latest.current.state;
      const on = !s.shuffle;
      dispatch({ shuffle: on, type: 'SHUFFLE', ...applyShuffle(s, on) });
    },
  };
  type Actions = typeof actions;

  useEffect(() => {
    actionsRef.current = actions;
  });

  // --- создание и события <audio> (один раз на приложение)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const a = () => actionsRef.current;
    const tick = (force = false) => {
      // Элемент без источника (после отмены/сброса) не должен затирать позицию в состоянии.
      if (!audio.getAttribute('src')) return;
      const now = performance.now();
      if (!force && now - lastTickRef.current < TICK_THROTTLE_MS) return;
      lastTickRef.current = now;
      const track = currentTrack(latest.current.state);
      const transcoded = isTranscoded(track);
      dispatch({
        // У перекодируемого потока нет Range: буфера и длительности элемента нет, берём длительность трека.
        buffered: transcoded ? [] : toRanges(audio.buffered),
        duration: transcoded ? (track?.durationMs ?? 0) / 1000 : audio.duration,
        position: positionOf(audio),
        type: 'TICK',
      });
    };
    const setStatus = (status: PlayerState['status']) => dispatch({ status, type: 'STATUS' });
    const on: Record<string, () => void> = {
      canplay: () => {
        if (!audio.paused) setStatus('playing');
      },
      durationchange: () => tick(true),
      ended: () => a()?.onEnded(),
      error: () => a()?.onError(),
      loadedmetadata: () => {
        if (pendingSeekRef.current > 0) {
          audio.currentTime = pendingSeekRef.current;
          pendingSeekRef.current = 0;
        }
        tick(true);
      },
      loadstart: () => {
        if (audio.getAttribute('src')) setStatus('loading');
      },
      pause: () => {
        dispatch({ type: 'PLAYING', value: false });
        if (!audio.ended && latestStatus() !== 'error' && latestStatus() !== 'idle') setStatus('paused');
      },
      play: () => dispatch({ type: 'PLAYING', value: true }),
      playing: () => setStatus('playing'),
      progress: () => tick(),
      // iOS Safari шлёт `stalled` и во время нормального воспроизведения: буферизация — только если данных реально нет.
      stalled: () => {
        if (!audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setStatus('buffering');
      },
      timeupdate: () => {
        // Время идёт — трек играет, даже если `playing`/`canplay` не пришли после `stalled`/`waiting`.
        const st = latestStatus();
        if (
          !audio.paused &&
          audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
          (st === 'buffering' || st === 'loading')
        ) {
          setStatus('playing');
        }
        tick();
      },
      waiting: () => {
        if (!audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setStatus('buffering');
      },
    };
    const latestStatus = () => latest.current.state.status;
    for (const [event, handler] of Object.entries(on)) audio.addEventListener(event, handler);

    return () => {
      for (const [event, handler] of Object.entries(on)) audio.removeEventListener(event, handler);
      clearTimeout(errorTimerRef.current);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loadedIdRef.current = null;
    };
  }, []);

  // --- восстановление сохранённого состояния (на паузе)
  useEffect(() => {
    let stored = null;
    try {
      stored = parseStored(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* localStorage недоступен */
    }
    if (!stored) return;
    pendingSeekRef.current = stored.position;
    if (audioRef.current) {
      audioRef.current.volume = stored.volume / 100;
      audioRef.current.muted = stored.muted;
    }
    dispatch({ stored, type: 'RESTORE' });
  }, []);

  // --- громкость элемента — из состояния (после восстановления и при смене)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = state.volume / 100;
    audio.muted = state.muted;
  }, [state.volume, state.muted]);

  // --- сохранение: при изменениях настроек/очереди и раз в 2 с (позиция)
  useEffect(() => {
    function persist() {
      const { state: s } = latest.current;
      if (s.queue.length === 0 && s.volume === initialState.volume) return;
      const pos = audioRef.current && loadedIdRef.current !== null ? positionOf(audioRef.current) : s.position;
      try {
        localStorage.setItem(STORAGE_KEY, serializeState(s, pos));
      } catch {
        /* переполнено/запрещено */
      }
    }
    persist();
    const id = setInterval(persist, PERSIST_INTERVAL_MS);
    window.addEventListener('pagehide', persist);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', persist);
    };
  }, [state.queue, state.index, state.volume, state.muted, state.shuffle, state.repeat]);

  // --- прогресс загрузки из торрента для текущего трека
  useLiveEvent('stream.progress', e => {
    if (currentTrack(latest.current.state)?.id !== e.track_id) return;
    dispatch({
      download: {
        bytes_done: e.bytes_done,
        bytes_total: e.bytes_total,
        down_speed_bps: e.down_speed_bps,
        peers: e.peers,
      },
      type: 'DOWNLOAD',
    });
  });

  // --- prefetch следующего трека: за 30 с до конца (или сразу, если включено `prefetch_next`)
  const [prefetchNext, setPrefetchNext] = useState(true);
  const prefetchedRef = useRef<number | null>(null);
  useEffect(() => {
    void loadPrefetchEnabled().then(setPrefetchNext);
  }, []);
  useEffect(() => {
    const { queue: q, index: i, repeat, duration: d, position: p, isPlaying } = state;
    if (!isPlaying || !(d > 0) || (!prefetchNext && d - p > PREFETCH_BEFORE_END_S)) return;
    const j = nextPlayableIndex(q, i, canPlayNow, repeat === 'all');
    const next = j >= 0 && j !== i ? q[j] : undefined;
    // Только `found`: у `ready` файл уже на диске.
    if (!next || (trackStatus.get(next.id)?.status ?? next.status) !== 'found') return;
    if (prefetchedRef.current === next.id) return;
    prefetchedRef.current = next.id;
    void prefetchTrack(next.id);
  });

  // --- Media Session
  const track = currentTrack(state);
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!track) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      album: track.album ?? '',
      artist: track.artist,
      artwork: track.coverUrl ? [{ sizes: '500x500', src: track.coverUrl }] : [],
      title: track.title,
    });
  }, [track]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => actionsRef.current?.resume()],
      ['pause', () => actionsRef.current?.pause()],
      ['previoustrack', () => actionsRef.current?.previous()],
      ['nexttrack', () => actionsRef.current?.next()],
      ['seekto', d => d.seekTime != null && actionsRef.current?.seekTo(d.seekTime)],
      ['seekbackward', d => actionsRef.current?.seekTo(positionNow() - (d.seekOffset ?? SEEK_STEP_S))],
      ['seekforward', d => actionsRef.current?.seekTo(positionNow() + (d.seekOffset ?? SEEK_STEP_S))],
    ];
    for (const [name, h] of handlers) {
      try {
        ms.setActionHandler(name, h);
      } catch {
        /* действие не поддерживается */
      }
    }
    return () => {
      for (const [name] of handlers) {
        try {
          ms.setActionHandler(name, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [positionNow]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = !track ? 'none' : state.isPlaying ? 'playing' : 'paused';
  }, [track, state.isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !track || !(state.duration > 0)) return;
    const now = Date.now();
    if (now - lastPositionStateRef.current < 1000) return;
    lastPositionStateRef.current = now;
    try {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: 1,
        position: Math.min(state.position, state.duration),
      });
    } catch {
      /* некорректные значения во время загрузки */
    }
  }, [track, state.position, state.duration]);

  // --- горячие клавиши
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const act = actionsRef.current;
      if (!act || !currentTrack(latest.current.state)) return;
      if (e.code === 'Space') {
        if (activatesOnSpace(e.target)) return;
        e.preventDefault();
        if (latest.current.state.isPlaying) act.pause();
        else act.resume();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) {
          if (dir < 0) act.previous();
          else act.next();
        } else act.seekTo(positionNow() + dir * SEEK_STEP_S);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [positionNow]);

  const { queue, index, duration, position } = state;
  const value: PlayerContextValue = {
    ...state,
    hasNext: nextPlayableIndex(queue, index, canPlayNow, state.repeat === 'all') >= 0,
    hasQueue: queue.length > 1,
    progress: duration > 0 ? Math.min(100, (position / duration) * 100) : 0,
    queueIndex: index,
    track,
    ...actions,
    seek: p => actions.seekTo((p / 100) * latest.current.state.duration),
    togglePlayPause() {
      if (state.isPlaying) actions.pause();
      else actions.resume();
    },
  };

  return (
    <PlayerContext.Provider value={value}>
      <audio ref={audioRef} preload="auto" hidden data-testid="player-audio" />
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
