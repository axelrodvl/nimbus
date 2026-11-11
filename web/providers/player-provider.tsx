'use client';

import { createContext, useContext, useReducer } from 'react';
import type { Track } from '@/types/track';

// ЗАГЛУШКА: состояние плеера (очередь, пауза, позиция, громкость) без звука.
// Шаг 19 заменит внутренности на реальный <audio> (src = /api/tracks/{id}/stream),
// публичный интерфейс `usePlayer()` при этом остаётся прежним.

type PlayerState = {
  track: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  /** Позиция, 0–100 (проценты). */
  progress: number;
  /** Громкость, 0–100. */
  volume: number;
};

type PlayerAction =
  | { type: 'PLAY'; track: Track; queue: Track[]; index: number }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'SEEK'; progress: number }
  | { type: 'SET_VOLUME'; volume: number };

const initialState: PlayerState = {
  isPlaying: false,
  progress: 0,
  queue: [],
  queueIndex: -1,
  track: null,
  volume: 75,
};

function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'PLAY':
      return {
        ...state,
        isPlaying: true,
        progress: 0,
        queue: action.queue,
        queueIndex: action.index,
        track: action.track,
      };
    case 'PAUSE':
      return { ...state, isPlaying: false };
    case 'RESUME':
      return { ...state, isPlaying: true };
    case 'SEEK':
      return { ...state, progress: Math.min(100, Math.max(0, action.progress)) };
    case 'SET_VOLUME':
      return { ...state, volume: action.volume };
  }
}

type PlayerContextValue = PlayerState & {
  hasQueue: boolean;
  play: (track: Track, queue?: Track[]) => void;
  pause: () => void;
  resume: () => void;
  togglePlayPause: () => void;
  next: () => void;
  previous: () => void;
  /** Перемотка, 0–100 (проценты). */
  seek: (progress: number) => void;
  setVolume: (v: number) => void;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(playerReducer, initialState);
  const { track, queue, queueIndex, isPlaying } = state;

  function playAtIndex(index: number, q: Track[]) {
    dispatch({ index, queue: q, track: q[index], type: 'PLAY' });
  }

  function play(t: Track, q?: Track[]) {
    const fullQueue = q ?? [t];
    const index = fullQueue.findIndex(x => x.id === t.id);
    playAtIndex(index >= 0 ? index : 0, fullQueue);
  }

  function pause() {
    dispatch({ type: 'PAUSE' });
  }

  function resume() {
    if (track) dispatch({ type: 'RESUME' });
  }

  function togglePlayPause() {
    if (isPlaying) pause();
    else resume();
  }

  function next() {
    if (!track || queue.length <= 1) return;
    playAtIndex(queueIndex < queue.length - 1 ? queueIndex + 1 : 0, queue);
  }

  function previous() {
    if (!track || queue.length <= 1) return;
    playAtIndex(queueIndex > 0 ? queueIndex - 1 : queue.length - 1, queue);
  }

  return (
    <PlayerContext.Provider
      value={{
        ...state,
        hasQueue: queue.length > 1,
        next,
        pause,
        play,
        previous,
        resume,
        seek: progress => dispatch({ progress, type: 'SEEK' }),
        setVolume: volume => dispatch({ type: 'SET_VOLUME', volume }),
        togglePlayPause,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
