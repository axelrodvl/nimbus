// Media Session: метаданные, обложка, действия экрана блокировки и медиаклавиш, позиция.
// Единственное место (вместе с `audio/web-engine.ts`), где разрешён `navigator.mediaSession`.
import type { NowPlaying, RemoteAction } from './audio/types';

export type RemoteCommand = { action: RemoteAction; seekTo?: number; offset?: number };

const ACTIONS: [MediaSessionAction, RemoteAction][] = [
  ['play', 'play'],
  ['pause', 'pause'],
  ['previoustrack', 'previous'],
  ['nexttrack', 'next'],
  ['seekto', 'seekto'],
  ['seekbackward', 'seekbackward'],
  ['seekforward', 'seekforward'],
];

/** Размеры обложки для экрана блокировки и уведомлений (96…512). */
export const ARTWORK_SIZES = [96, 128, 192, 256, 384, 512] as const;
/** Логотип приложения: обложка по умолчанию и запасная без сети. */
export const FALLBACK_ARTWORK = '/icons/icon-512.png';

export function artworkFor(coverUrl: string | null): MediaImage[] {
  if (!coverUrl) return [{ sizes: '512x512', src: FALLBACK_ARTWORK, type: 'image/png' }];
  return ARTWORK_SIZES.map(n => ({ sizes: `${n}x${n}`, src: coverUrl }));
}

async function fallbackIfUncached(meta: NowPlaying, session: MediaSession): Promise<void> {
  try {
    const hit = await globalThis.caches?.match(meta.coverUrl ?? '');
    if (hit || !session.metadata) return;
    session.metadata = new MediaMetadata({
      album: meta.album,
      artist: meta.artist,
      artwork: artworkFor(null),
      title: meta.title,
    });
  } catch {
    // Кэш недоступен — остаётся обложка по адресу.
  }
}

export type MediaSessionHandle = {
  /** Переустановить обработчики и метаданные (после смены `src` часть версий Safari их теряет). */
  refresh(meta: NowPlaying | null): void;
  setMetadata(meta: NowPlaying | null): void;
  setPlaybackState(state: 'playing' | 'paused' | 'none'): void;
  setPosition(position: number, duration: number): void;
  dispose(): void;
};

const noop: MediaSessionHandle = { dispose() {}, refresh() {}, setMetadata() {}, setPlaybackState() {}, setPosition() {} };

/** Подключает Media Session; действия превращаются в команды `onCommand`. Без поддержки браузера — пустая заглушка. */
export function createMediaSession(
  onCommand: (c: RemoteCommand) => void,
  session: MediaSession | undefined = globalThis.navigator?.mediaSession,
): MediaSessionHandle {
  if (!session) return noop;
  const install = () => {
    for (const [name, action] of ACTIONS) {
      try {
        session.setActionHandler(name, d => onCommand({ action, offset: d.seekOffset, seekTo: d.seekTime }));
      } catch {
        // Действие не поддерживается этим браузером.
      }
    }
  };
  install();
  const setMetadata = (meta: NowPlaying | null) => {
    session.metadata = meta
      ? new MediaMetadata({
          album: meta.album,
          artist: meta.artist,
          artwork: artworkFor(meta.coverUrl),
          title: meta.title,
        })
      : null;
    // Без сети обложку, которой нет в кэше, система не загрузит: показываем логотип.
    if (meta?.coverUrl && globalThis.navigator?.onLine === false) void fallbackIfUncached(meta, session);
  };
  return {
    dispose() {
      for (const [name] of ACTIONS) {
        try {
          session.setActionHandler(name, null);
        } catch {
          // Нечего снимать.
        }
      }
      session.metadata = null;
    },
    refresh(meta) {
      install();
      setMetadata(meta);
    },
    setMetadata,
    setPlaybackState(state) {
      session.playbackState = state;
    },
    setPosition(position, duration) {
      if (!(duration > 0)) return;
      try {
        session.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(position, 0), duration) });
      } catch {
        // Некорректные значения во время загрузки.
      }
    },
  };
}
