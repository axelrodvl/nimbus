// Реализация `AudioEngine` для PWA и настольной оболочки: один `HTMLAudioElement` на всё приложение
// (создаётся один раз вне React и живёт всю жизнь вкладки) + Media Session.
// Единственное место (вместе с `../media-session.ts`), где разрешён `HTMLAudioElement`.
import { toRanges } from '../engine';
import { createMediaSession, type MediaSessionHandle } from '../media-session';
import type {
  AudioCapabilities,
  AudioEngine,
  AudioEvent,
  AudioPosition,
  AudioSource,
  LoadOptions,
  NowPlaying,
} from './types';

export type WebAudioDeps = {
  /** Элемент (в тестах — фейк). По умолчанию создаётся скрытый `<audio>` в `document.body`. */
  audio?: HTMLAudioElement;
  mediaSession?: MediaSession;
};

const POSITION_STATE_INTERVAL_MS = 1000;
const HAVE_FUTURE_DATA = 3;

export function createAudioElement(): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.hidden = true;
  audio.dataset.testid = 'player-audio';
  audio.setAttribute('data-testid', 'player-audio');
  document.body.append(audio);
  return audio;
}

/** Фаза воспроизведения, о которой движок уже сообщил: чтобы не слать `playing` на каждый `timeupdate`. */
type Phase = 'idle' | 'loading' | 'waiting' | 'playing' | 'paused';

export function createWebAudioEngine(deps: WebAudioDeps = {}): AudioEngine {
  const audio = deps.audio ?? createAudioElement();
  const handlers = new Set<(e: AudioEvent) => void>();
  const emit = (e: AudioEvent) => handlers.forEach(h => h(e));
  const session: MediaSessionHandle = createMediaSession(
    c => emit({ type: 'remote', ...c }),
    deps.mediaSession ?? globalThis.navigator?.mediaSession,
  );

  /** Адрес, загруженный последним вызовом `load`; `null` — источника нет (после `unload`). */
  let loadedUrl: string | null = null;
  let mode: AudioSource['mode'] = 'direct';
  /** Для `transcode`: секунда трека, с которой начался поток. */
  let offset = 0;
  /** Позиция, к которой перейти после `loadedmetadata`. */
  let pendingSeek = 0;
  let nowPlaying: NowPlaying | null = null;
  let phase: Phase = 'idle';
  let lastPositionState = 0;
  let listening = true;

  const setPhase = (next: Phase) => {
    phase = next;
    session.setPlaybackState(next === 'idle' ? 'none' : next === 'paused' ? 'paused' : 'playing');
  };

  // Событие относится к источнику, который сейчас загружен (старый `src` после замены/сброса игнорируется).
  const isCurrent = () => loadedUrl !== null && audio.getAttribute('src') === loadedUrl;
  const hasData = () => audio.readyState >= HAVE_FUTURE_DATA;

  function position(): AudioPosition {
    if (loadedUrl === null) return { buffered: [], current: pendingSeek, duration: nowPlaying?.durationS ?? 0 };
    const finite = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (mode === 'transcode') {
      // У перекодируемого потока нет Range: буфера и длительности потока нет, длительность берём у трека.
      return { buffered: [], current: offset + audio.currentTime, duration: nowPlaying?.durationS || offset + finite };
    }
    return {
      buffered: toRanges(audio.buffered),
      current: audio.currentTime,
      duration: finite || nowPlaying?.durationS || 0,
    };
  }

  function syncSessionPosition(force = false) {
    const now = Date.now();
    if (!force && now - lastPositionState < POSITION_STATE_INTERVAL_MS) return;
    lastPositionState = now;
    const p = position();
    session.setPosition(p.current, p.duration);
  }

  const listeners: Record<string, () => void> = {
    canplay: () => {
      if (isCurrent() && !audio.paused && phase !== 'playing') {
        setPhase('playing');
        emit({ type: 'playing' });
      }
    },
    ended: () => {
      if (!isCurrent()) return;
      setPhase('paused');
      emit({ type: 'ended' });
    },
    error: () => {
      if (isCurrent()) emit({ code: 'media', type: 'error' });
    },
    loadedmetadata: () => {
      if (!isCurrent()) return;
      if (pendingSeek > 0) {
        audio.currentTime = pendingSeek;
        pendingSeek = 0;
      }
      syncSessionPosition(true);
    },
    loadstart: () => {
      if (!isCurrent() || audio.paused) return;
      setPhase('loading');
      emit({ type: 'loading' });
    },
    pause: () => {
      if (!isCurrent() || audio.ended) return;
      setPhase('paused');
      emit({ type: 'paused' });
      syncSessionPosition(true);
    },
    playing: () => {
      if (!isCurrent()) return;
      setPhase('playing');
      emit({ type: 'playing' });
      syncSessionPosition(true);
    },
    // iOS Safari шлёт `stalled` и во время нормального воспроизведения: буферизация — только если данных реально нет.
    stalled: () => listeners.waiting(),
    timeupdate: () => {
      if (!isCurrent()) return;
      // Время идёт — трек играет, даже если `playing`/`canplay` не пришли после `stalled`/`waiting`.
      if (!audio.paused && hasData() && (phase === 'waiting' || phase === 'loading')) {
        setPhase('playing');
        emit({ type: 'playing' });
      }
      syncSessionPosition();
    },
    waiting: () => {
      if (isCurrent() && !audio.paused && !hasData() && phase !== 'waiting') {
        setPhase('waiting');
        emit({ type: 'waiting' });
      }
    },
  };
  for (const [name, fn] of Object.entries(listeners)) audio.addEventListener(name, fn);

  function reset() {
    // Сначала «источника нет»: события, вызванные самим сбросом (`pause`), не должны дойти до контроллера.
    loadedUrl = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    pendingSeek = 0;
    offset = 0;
  }

  const capabilities: AudioCapabilities = {
    backgroundSafe: false,
    gapless: false,
    headers: false,
    nativeNowPlaying: false,
  };

  return {
    capabilities,
    dispose() {
      if (!listening) return;
      listening = false;
      for (const [name, fn] of Object.entries(listeners)) audio.removeEventListener(name, fn);
      reset();
      session.dispose();
      handlers.clear();
    },
    getPosition: position,
    load(src: AudioSource, opts: LoadOptions) {
      mode = src.mode;
      offset = src.mode === 'transcode' ? (opts.positionOffset ?? 0) : 0;
      pendingSeek = src.mode === 'transcode' ? 0 : opts.startAt;
      loadedUrl = src.url;
      // Без автозапуска трек не «подключается»: иначе фаза навсегда осталась бы `loading`.
      setPhase(opts.autoplay ? 'loading' : 'paused');
      audio.src = src.url;
      if (opts.autoplay) {
        // Синхронно, в том же тике: iOS разрешает запуск только из обработчика жеста.
        audio.play().catch((e: unknown) => {
          // AbortError — загрузку заменили другим треком; иное (NotAllowedError — политика автозапуска) — пауза.
          if (e instanceof DOMException && e.name === 'AbortError') return;
          if (isCurrent()) {
            setPhase('paused');
            emit({ type: 'paused' });
          }
        });
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    pause() {
      audio.pause();
    },
    async play() {
      try {
        await audio.play();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        throw e;
      }
    },
    // Предзагрузку следующего трека делает сервер (`POST /api/tracks/{id}/prefetch`): второй поток рядом с
    // единственным элементом не нужен, а gapless в вебе не поддерживается (`capabilities.gapless = false`).
    preloadNext() {},
    seek(seconds) {
      if (loadedUrl === null) pendingSeek = seconds;
      else audio.currentTime = seconds;
    },
    setNowPlaying(meta) {
      nowPlaying = meta;
      session.setMetadata(meta);
      if (meta === null) setPhase('idle');
      else syncSessionPosition(true);
    },
    setVolume(v) {
      audio.volume = Math.min(1, Math.max(0, v));
    },
    unload() {
      reset();
      setPhase('idle');
    },
  };
}

let instance: AudioEngine | null = null;

/** Единственный движок вкладки (создаётся при первом обращении). */
export function sharedWebAudioEngine(): AudioEngine {
  instance ??= createWebAudioEngine();
  return instance;
}
