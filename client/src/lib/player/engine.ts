// Чистая логика плеера (без DOM и React): состояние, редьюсер, очередь, shuffle, сохранение, ошибки.
// Побочные эффекты (звук, Media Session, localStorage) — в `controller.ts` и `audio/`.
// Перенесено из `web/providers/player/engine.ts` без изменений логики. Отличия: очередь — `PlayerTrack`;
// из состояния убраны `buffered` (его отдаёт `AudioEngine.getPosition()`) и `download` (прогресс — в live-store).
import type { TFn } from '@/lib/i18n/messages';
import type { StreamProgress } from '@/lib/store/live';
import type { PlayerTrack as Track } from './track';

export type PlayerStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';
export type PlayerError = { code: string };

export type PlayerState = {
  queue: Track[];
  /** Порядок до перемешивания (только при включённом shuffle). */
  originalQueue: Track[] | null;
  index: number;
  status: PlayerStatus;
  error?: PlayerError;
  /** Намерение «играть» (аналог `!audio.paused`). */
  isPlaying: boolean;
  /** Пауза пришла не от пользователя (звонок, Siri, наушники): `play` с экрана блокировки или гарнитуры продолжает. */
  interrupted: boolean;
  /**
   * Секунды: позиция в момент последнего события (загрузка, перемотка, пауза, сохранение). Текущую позицию
   * во время воспроизведения читают из `AudioEngine.getPosition()` (`useProgress`), а не отсюда.
   */
  position: number;
  duration: number;
  /** 0–100. */
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
};

export const initialState: PlayerState = {
  duration: 0,
  index: -1,
  interrupted: false,
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

export function currentTrack(s: Pick<PlayerState, 'queue' | 'index'>): Track | null {
  return s.queue[s.index] ?? null;
}

const durationOf = (t: Track | undefined) => (t?.durationMs ? t.durationMs / 1000 : 0);

export type PlayerAction =
  | { type: 'LOAD'; queue: Track[]; originalQueue: Track[] | null; index: number; position?: number }
  | { type: 'GOTO'; index: number }
  | { type: 'STATUS'; status: PlayerStatus; error?: PlayerError }
  | { type: 'PLAYING'; value: boolean }
  | { type: 'INTERRUPTED' }
  | { type: 'TICK'; position: number; duration?: number }
  | { type: 'STOP' }
  | { type: 'CANCEL' }
  | { type: 'VOLUME'; volume: number }
  | { type: 'MUTED'; muted: boolean }
  | { type: 'REPEAT'; repeat: RepeatMode }
  | { type: 'SHUFFLE'; shuffle: boolean; queue: Track[]; originalQueue: Track[] | null; index: number }
  | { type: 'ENQUEUE'; track: Track }
  | { type: 'PLAY_NEXT'; track: Track }
  | { type: 'REMOVE'; index: number }
  | { type: 'MOVE'; from: number; to: number }
  | { type: 'RESTORE'; stored: StoredPlayer };

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'LOAD':
    case 'GOTO': {
      const queue = action.type === 'LOAD' ? action.queue : state.queue;
      const index = action.index;
      return {
        ...state,
        duration: durationOf(queue[index]),
        error: undefined,
        index,
        interrupted: false,
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
      return { ...state, interrupted: action.value ? false : state.interrupted, isPlaying: action.value };
    case 'INTERRUPTED':
      return { ...state, interrupted: true, isPlaying: false };
    case 'TICK':
      return {
        ...state,
        duration: action.duration && Number.isFinite(action.duration) ? action.duration : state.duration,
        position: action.position,
      };
    case 'STOP':
      return { ...state, interrupted: false, isPlaying: false, position: 0, status: 'paused' };
    case 'CANCEL':
      return { ...state, interrupted: false, isPlaying: false, status: 'idle' };
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
    case 'MOVE': {
      // Переставляются только следующие за текущим треки; текущий и уже сыгранные остаются на местах.
      const { from, to } = action;
      const last = state.queue.length - 1;
      if (from === to || from <= state.index || to <= state.index || from > last || to > last) return state;
      const queue = [...state.queue];
      const [moved] = queue.splice(from, 1);
      queue.splice(to, 0, moved);
      return { ...state, queue };
    }
    case 'RESTORE': {
      const s = action.stored;
      return {
        ...state,
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
/** Сколько уже сыгранных треков сохранять перед текущим, если очередь длиннее лимита. */
const STORED_BEFORE_CURRENT = 20;

/** Окно не больше `MAX_STORED_TRACKS` вокруг `center`: длинная очередь сохраняется вместе с текущим треком. */
function windowAround(list: Track[], center: number): { items: Track[]; start: number } {
  const start = Math.max(0, Math.min(center - STORED_BEFORE_CURRENT, list.length - MAX_STORED_TRACKS));
  return { items: list.slice(start, start + MAX_STORED_TRACKS), start };
}

export function serializeState(s: PlayerState, position: number): string {
  const queue = windowAround(s.queue, s.index);
  const currentId = s.queue[s.index]?.id;
  const originalAt = s.originalQueue ? s.originalQueue.findIndex(t => t.id === currentId) : -1;
  const stored: StoredPlayer = {
    index: s.index - queue.start,
    muted: s.muted,
    originalQueue: s.originalQueue ? windowAround(s.originalQueue, Math.max(originalAt, 0)).items : null,
    position,
    queue: queue.items,
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
    const v = JSON.parse(raw) as Partial<StoredPlayer> | null;
    if (!v || v.v !== 1 || !Array.isArray(v.queue) || !v.queue.every(isTrack)) return null;
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

const KNOWN_ERRORS = [
  'ffmpeg_missing',
  'no_peers',
  'track_not_playable',
  'transcode_failed',
  'transcoder_busy',
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];
const isKnownError = (code: string): code is KnownError => (KNOWN_ERRORS as readonly string[]).includes(code);

/** Код ошибки бэкенда; неизвестные коды показываются как общая ошибка воспроизведения. */
export function describeBackendError(code: string | undefined): PlayerError {
  return { code: code ?? 'unknown' };
}

/** Текст ошибки плеера на языке интерфейса. */
export function playerErrorText(t: TFn, code: string): string {
  if (isKnownError(code)) return t(`player.error.${code}`);
  if (code === 'network') return t('player.error.network');
  return t('player.error.default');
}

/**
 * Браузер не сообщает причину отказа `<audio>`: спрашиваем бэкенд `HEAD`-запросом.
 * Если `HEAD` проходит (он не трогает торрент-движок), отказ случился при чтении данных — это `no_peers`.
 */
export async function probeStreamError(
  url: string,
  doFetch: typeof fetch = fetch,
  headers?: Record<string, string>,
): Promise<PlayerError> {
  try {
    const res = await doFetch(url, { credentials: 'include', headers, method: 'HEAD' });
    if (res.ok) return describeBackendError('no_peers');
    // У HEAD нет тела — код берём из статуса.
    const byStatus: Record<number, string> = {
      409: 'track_not_playable',
      503: 'ffmpeg_missing',
      504: 'no_peers',
    };
    return describeBackendError(byStatus[res.status]);
  } catch {
    return { code: 'network' };
  }
}

// ------------------------------------------------------------------ форматирование

export function formatSpeed(bps: number, t: TFn): string {
  if (bps >= 1024 * 1024) return t('speed.MB', { n: (bps / 1024 / 1024).toFixed(1) });
  if (bps >= 1024) return t('speed.KB', { n: Math.round(bps / 1024) });
  return t('speed.B', { n: bps });
}

/** «Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с» (на языке интерфейса). */
export function describeDownload(d: StreamProgress, t: TFn): string {
  const pct = d.bytes_total > 0 ? Math.min(100, Math.floor((d.bytes_done / d.bytes_total) * 100)) : 0;
  return t('player.download', {
    pct,
    peers: t('count.peers', { count: d.peers }),
    speed: formatSpeed(d.down_speed_bps, t),
  });
}

/** Диапазоны буфера `TimeRanges` → массив пар (в контракт `AudioEngine` `TimeRanges` не попадает). */
export function toRanges(r: { length: number; start(i: number): number; end(i: number): number }): [number, number][] {
  return Array.from({ length: r.length }, (_, i) => [r.start(i), r.end(i)] as [number, number]);
}

// --- Счётчик прослушиваний

/** Прослушивание засчитывается после половины трека, но не позже чем через 4 минуты (длительность неизвестна — 30 с). */
const PLAY_COUNT_MAX_S = 240;
const PLAY_COUNT_UNKNOWN_DURATION_S = 30;
/** Скачок позиции больше этого между обновлениями — перемотка, а не прослушивание. */
export const LISTEN_MAX_STEP_S = 2;

/** Сколько секунд нужно реально прослушать, чтобы трек засчитался. */
export const playCountThreshold = (durationS: number) =>
  durationS > 0 ? Math.min(durationS / 2, PLAY_COUNT_MAX_S) : PLAY_COUNT_UNKNOWN_DURATION_S;

/** Накопленное время реального воспроизведения текущего трека. */
export type Listen = { trackId: number; seconds: number; last: number | null; counted: boolean };

/**
 * Очередное обновление позиции во время воспроизведения. Перемотки (скачок позиции) время не копят.
 * `count: true` возвращается ровно один раз на трек — когда набрано достаточно.
 */
export function advanceListen(
  prev: Listen | null,
  trackId: number,
  position: number,
  durationS: number,
): { listen: Listen; count: boolean } {
  const l: Listen = prev?.trackId === trackId ? { ...prev } : { counted: false, last: null, seconds: 0, trackId };
  const delta = l.last === null ? 0 : position - l.last;
  l.last = position;
  if (delta > 0 && delta < LISTEN_MAX_STEP_S) l.seconds += delta;
  const count = !l.counted && l.seconds >= playCountThreshold(durationS);
  if (count) l.counted = true;
  return { count, listen: l };
}
