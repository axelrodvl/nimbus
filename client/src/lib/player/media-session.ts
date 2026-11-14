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

export type MediaSessionHandle = {
  setMetadata(meta: NowPlaying | null): void;
  setPlaybackState(state: 'playing' | 'paused' | 'none'): void;
  setPosition(position: number, duration: number): void;
  dispose(): void;
};

const noop: MediaSessionHandle = { dispose() {}, setMetadata() {}, setPlaybackState() {}, setPosition() {} };

/** Подключает Media Session; действия превращаются в команды `onCommand`. Без поддержки браузера — пустая заглушка. */
export function createMediaSession(
  onCommand: (c: RemoteCommand) => void,
  session: MediaSession | undefined = globalThis.navigator?.mediaSession,
): MediaSessionHandle {
  if (!session) return noop;
  for (const [name, action] of ACTIONS) {
    try {
      session.setActionHandler(name, d => onCommand({ action, offset: d.seekOffset, seekTo: d.seekTime }));
    } catch {
      // Действие не поддерживается этим браузером.
    }
  }
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
    setMetadata(meta) {
      session.metadata = meta
        ? new MediaMetadata({
            album: meta.album,
            artist: meta.artist,
            artwork: meta.coverUrl ? [{ sizes: '500x500', src: meta.coverUrl }] : [],
            title: meta.title,
          })
        : null;
    },
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
