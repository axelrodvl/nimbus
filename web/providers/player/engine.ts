// Чистая логика плеера (без DOM и React): состояние, редьюсер, очередь, shuffle, сохранение, ошибки.
// Побочные эффекты (HTMLAudioElement, Media Session, localStorage) живут в `providers/player-provider.tsx`.
import type { TrackStatus } from '@/lib/api/events';
import type { Track } from '@/types/track';

export type PlayerStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';
export type DownloadInfo = { bytes_done: number; bytes_total: number; peers: number; down_speed_bps: number };
export type PlayerError = { code: string; message: string };

export type PlayerState = {
  queue: Track[];
  /** Порядок до перемешивания (только при включённом shuffle). */
  originalQueue: Track[] | null;
  index: number;
  status: PlayerStatus;
  error?: PlayerError;
  /** Намерение «играть» (аналог `!audio.paused`). */
  isPlaying: boolean;
  /** Секунды. */
  position: number;
  duration: number;
  buffered: [number, number][];
  /** 0–100. */
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  download?: DownloadInfo;
};

export const initialState: PlayerState = {
  buffered: [],
  duration: 0,
  index: -1,
  isPlaying: false,
  muted: false,
  originalQueue: null,
  position: 0,
  queue: [],
  repeat: 'off',
  shuffle: false,
  status: 'idle',
  volume: 75,
};

export const PREVIOUS_RESTART_THRESHOLD_S = 3;

export const canPlayStatus = (status: TrackStatus) => status === 'found' || status === 'ready';

export function currentTrack(s: Pick<PlayerState, 'queue' | 'index'>): Track | null {
  return s.queue[s.index] ?? null;
}

const durationOf = (t: Track | undefined) => (t?.durationMs ? t.durationMs / 1000 : 0);

export type PlayerAction =
  | { type: 'LOAD'; queue: Track[]; originalQueue: Track[] | null; index: number; position?: number }
  | { type: 'GOTO'; index: number }
  | { type: 'STATUS'; status: PlayerStatus; error?: PlayerError }
  | { type: 'PLAYING'; value: boolean }
  | { type: 'TICK'; position: number; duration?: number; buffered?: [number, number][] }
  | { type: 'DOWNLOAD'; download: DownloadInfo | undefined }
  | { type: 'STOP' }
  | { type: 'CANCEL' }
  | { type: 'VOLUME'; volume: number }
  | { type: 'MUTED'; muted: boolean }
  | { type: 'REPEAT'; repeat: RepeatMode }
  | { type: 'SHUFFLE'; shuffle: boolean; queue: Track[]; originalQueue: Track[] | null; index: number }
  | { type: 'ENQUEUE'; track: Track }
  | { type: 'PLAY_NEXT'; track: Track }
  | { type: 'REMOVE'; index: number }
  | { type: 'RESTORE'; stored: StoredPlayer };

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'LOAD':
    case 'GOTO': {
      const queue = action.type === 'LOAD' ? action.queue : state.queue;
      const index = action.index;
      return {
        ...state,
        buffered: [],
        download: undefined,
        duration: durationOf(queue[index]),
        error: undefined,
        index,
        isPlaying: true,
        originalQueue: action.type === 'LOAD' ? action.originalQueue : state.originalQueue,
        position: action.type === 'LOAD' ? (action.position ?? 0) : 0,
        queue,
        status: 'loading',
      };
    }
    case 'STATUS':
      return { ...state, error: action.status === 'error' ? action.error : undefined, status: action.status };
    case 'PLAYING':
      return { ...state, isPlaying: action.value };
    case 'TICK':
      return {
        ...state,
        buffered: action.buffered ?? state.buffered,
        duration: action.duration && Number.isFinite(action.duration) ? action.duration : state.duration,
        position: action.position,
      };
    case 'DOWNLOAD':
      return { ...state, download: action.download };
    case 'STOP':
      return { ...state, isPlaying: false, position: 0, status: 'paused' };
    case 'CANCEL':
      return { ...state, buffered: [], download: undefined, isPlaying: false, status: 'idle' };
    case 'VOLUME':
      return { ...state, volume: Math.min(100, Math.max(0, Math.round(action.volume))) };
    case 'MUTED':
      return { ...state, muted: action.muted };
    case 'REPEAT':
      return { ...state, repeat: action.repeat };
    case 'SHUFFLE':
      return {
        ...state,
        index: action.index,
        originalQueue: action.originalQueue,
        queue: action.queue,
        shuffle: action.shuffle,
      };
    case 'ENQUEUE':
      return {
        ...state,
        originalQueue: state.originalQueue ? [...state.originalQueue, action.track] : null,
        queue: [...state.queue, action.track],
      };
    case 'PLAY_NEXT': {
      const at = state.index + 1;
      return {
        ...state,
        originalQueue: state.originalQueue ? [...state.originalQueue, action.track] : null,
        queue: [...state.queue.slice(0, at), action.track, ...state.queue.slice(at)],
      };
    }
    case 'REMOVE': {
      // Текущий трек из очереди не удаляется.
      if (action.index === state.index || action.index < 0 || action.index >= state.queue.length) return state;
      const removed = state.queue[action.index];
      return {
        ...state,
        index: action.index < state.index ? state.index - 1 : state.index,
        originalQueue: state.originalQueue ? state.originalQueue.filter(t => t.id !== removed.id) : null,
        queue: state.queue.filter((_, i) => i !== action.index),
      };
    }
    case 'RESTORE': {
      const s = action.stored;
      return {
        ...state,
        buffered: [],
        duration: durationOf(s.queue[s.index]),
        index: s.index,
        isPlaying: false,
        muted: s.muted,
        originalQueue: s.originalQueue,
        position: s.position,
        queue: s.queue,
        repeat: s.repeat,
        shuffle: s.shuffle,
        status: s.queue.length > 0 ? 'paused' : 'idle',
        volume: s.volume,
      };
    }
  }
}

// ------------------------------------------------------------------ очередь

/** Следующий играбельный индекс после `from` (с переходом в начало при `wrap`), иначе -1. */
export function nextPlayableIndex(queue: Track[], from: number, canPlay: (t: Track) => boolean, wrap: boolean): number {
  for (let i = from + 1; i < queue.length; i++) if (canPlay(queue[i])) return i;
  if (wrap) for (let i = 0; i <= from && i < queue.length; i++) if (canPlay(queue[i])) return i;
  return -1;
}

export function prevPlayableIndex(queue: Track[], from: number, canPlay: (t: Track) => boolean, wrap: boolean): number {
  for (let i = from - 1; i >= 0; i--) if (canPlay(queue[i])) return i;
  if (wrap) for (let i = queue.length - 1; i >= from && i >= 0; i--) if (canPlay(queue[i])) return i;
  return -1;
}

/** Перемешивает всё, кроме текущего: он становится первым. */
export function shuffleAround(queue: Track[], index: number, rng: () => number = Math.random): Track[] {
  const current = queue[index];
  const rest = queue.filter((_, i) => i !== index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return current ? [current, ...rest] : rest;
}

/** Очередь и индекс после включения/выключения shuffle. */
export function applyShuffle(
  state: Pick<PlayerState, 'queue' | 'originalQueue' | 'index'>,
  on: boolean,
  rng: () => number = Math.random,
): { queue: Track[]; originalQueue: Track[] | null; index: number } {
  const current = state.queue[state.index];
  if (on) {
    if (!current) return { index: state.index, originalQueue: [...state.queue], queue: state.queue };
    return { index: 0, originalQueue: [...state.queue], queue: shuffleAround(state.queue, state.index, rng) };
  }
  const original = state.originalQueue ?? state.queue;
  // Добавленные за время shuffle треки уже есть в `originalQueue` (см. ENQUEUE/PLAY_NEXT).
  const index = current ? original.findIndex(t => t.id === current.id) : -1;
  return { index: index >= 0 ? index : state.index, originalQueue: null, queue: original };
}

// ------------------------------------------------------------------ сохранение

export type StoredPlayer = {
  v: 1;
  queue: Track[];
  originalQueue: Track[] | null;
  index: number;
  position: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
};

export const STORAGE_KEY = 'nimbus:player';
const MAX_STORED_TRACKS = 200;

export function serializeState(s: PlayerState, position: number): string {
  const stored: StoredPlayer = {
    index: s.index,
    muted: s.muted,
    originalQueue: s.originalQueue ? s.originalQueue.slice(0, MAX_STORED_TRACKS) : null,
    position,
    queue: s.queue.slice(0, MAX_STORED_TRACKS),
    repeat: s.repeat,
    shuffle: s.shuffle,
    v: 1,
    volume: s.volume,
  };
  return JSON.stringify(stored);
}

const isTrack = (t: unknown): t is Track =>
  typeof t === 'object' &&
  t !== null &&
  typeof (t as Track).id === 'number' &&
  typeof (t as Track).title === 'string' &&
  typeof (t as Track).artist === 'string';

export function parseStored(raw: string | null): StoredPlayer | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredPlayer>;
    if (v.v !== 1 || !Array.isArray(v.queue) || !v.queue.every(isTrack)) return null;
    const queue = v.queue;
    const index = typeof v.index === 'number' && v.index >= 0 && v.index < queue.length ? v.index : -1;
    const repeat: RepeatMode = v.repeat === 'all' || v.repeat === 'one' ? v.repeat : 'off';
    const volume = typeof v.volume === 'number' ? Math.min(100, Math.max(0, v.volume)) : initialState.volume;
    const original =
      Array.isArray(v.originalQueue) && v.originalQueue.every(isTrack) && v.shuffle ? v.originalQueue : null;
    return {
      index: queue.length > 0 ? Math.max(index, 0) : -1,
      muted: v.muted === true,
      originalQueue: original,
      position: typeof v.position === 'number' && v.position > 0 ? v.position : 0,
      queue,
      repeat,
      shuffle: v.shuffle === true && original !== null,
      v: 1,
      volume,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ ошибки бэкенда

export const BACKEND_ERROR_TEXT: Record<string, string> = {
  ffmpeg_missing: 'На сервере не установлен ffmpeg: образы CUE и форматы APE/WV/DSD не играют',
  no_peers: 'Нет пиров: не удалось получить данные раздачи',
  track_not_playable: 'Трек ещё не найден — слушать пока нельзя',
  transcode_failed: 'Не удалось перекодировать файл',
  transcoder_busy: 'Сервер занят перекодированием, попробуйте через минуту',
};

export function describeBackendError(code: string | undefined): PlayerError {
  const key = code ?? 'unknown';
  return { code: key, message: BACKEND_ERROR_TEXT[key] ?? 'Не удалось воспроизвести трек' };
}

/**
 * Браузер не сообщает причину отказа `<audio>`: спрашиваем бэкенд `HEAD`-запросом.
 * Если `HEAD` проходит (он не трогает торрент-движок), отказ случился при чтении данных — это `no_peers`.
 */
export async function probeStreamError(url: string, doFetch: typeof fetch = fetch): Promise<PlayerError> {
  try {
    const res = await doFetch(url, { method: 'HEAD' });
    if (res.ok) return describeBackendError('no_peers');
    // У HEAD нет тела — код берём из статуса.
    const byStatus: Record<number, string> = {
      409: 'track_not_playable',
      503: 'ffmpeg_missing',
      504: 'no_peers',
    };
    return describeBackendError(byStatus[res.status]);
  } catch {
    return { code: 'network', message: 'Нет связи с сервером' };
  }
}

// ------------------------------------------------------------------ форматирование

export function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} МБ/с`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} КБ/с`;
  return `${bps} Б/с`;
}

/** «Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с». */
export function describeDownload(d: DownloadInfo): string {
  const pct = d.bytes_total > 0 ? Math.min(100, Math.floor((d.bytes_done / d.bytes_total) * 100)) : 0;
  const peers =
    d.peers % 10 === 1 && d.peers % 100 !== 11
      ? 'пир'
      : [2, 3, 4].includes(d.peers % 10) && ![12, 13, 14].includes(d.peers % 100)
        ? 'пира'
        : 'пиров';
  return `Загрузка из торрента: ${pct}% · ${d.peers} ${peers} · ${formatSpeed(d.down_speed_bps)}`;
}

export function toRanges(r: { length: number; start(i: number): number; end(i: number): number }): [number, number][] {
  return Array.from({ length: r.length }, (_, i) => [r.start(i), r.end(i)] as [number, number]);
}
