import { vi } from 'vitest';
import type { AudioSource } from '@/lib/player/audio/types';
import { PlayerController, type PlayerDeps, type PlayerStorage } from '@/lib/player/controller';
import type { PlayerError } from '@/lib/player/engine';
import type { PlayerTrack } from '@/lib/player/track';
import { FakeAudioEngine } from './fake-engine';

/** Трек для тестов плеера. */
export function pt(id: number, over: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    album: 'Album',
    albumId: 7,
    artist: 'Artist',
    artistId: 3,
    coverUrl: null,
    durationMs: 10_000,
    id,
    playback: 'direct',
    status: 'found',
    title: `T${id}`,
    ...over,
  };
}

export class MemStorage implements PlayerStorage {
  data = new Map<string, string>();
  writes = 0;
  fail = false;
  getItem(k: string) {
    if (this.fail) throw new Error('denied');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw new Error('quota');
    this.writes++;
    this.data.set(k, v);
  }
}

export type Setup = {
  engine: FakeAudioEngine;
  /** «Библиотека»: актуальные данные треков. */
  library: Map<number, PlayerTrack>;
  deps: PlayerDeps;
  ctl: PlayerController;
  storage: MemStorage;
  notify: ReturnType<typeof vi.fn>;
  recordPlay: ReturnType<typeof vi.fn>;
  prefetchTrack: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  libListeners: Set<() => void>;
  settings: { ready: boolean; prefetch: boolean };
  changeLibrary(): void;
};

export const ids = (ctl: PlayerController) => ctl.state.queue.map(t => t.id);

export function setup(
  over: Partial<PlayerDeps> = {},
  tracks: PlayerTrack[] = [1, 2, 3, 4].map(i => pt(i)),
  storage = new MemStorage(),
): Setup {
  const engine = new FakeAudioEngine();
  const library = new Map(tracks.map(t => [t.id, t]));
  const libListeners = new Set<() => void>();
  const settings = { prefetch: true, ready: true };
  const notify = vi.fn();
  const recordPlay = vi.fn(async () => undefined);
  const prefetchTrack = vi.fn(async () => undefined);
  const probe = vi.fn(async (): Promise<PlayerError> => ({ code: 'no_peers' }));
  const resolve = vi.fn((t: PlayerTrack, start: number): AudioSource => ({
    mode: t.playback === 'transcode' ? 'transcode' : 'direct',
    url: `/s/${t.id}${start > 0 ? `?t=${start}` : ''}`,
  }));
  const deps: PlayerDeps = {
    engine,
    getTrack: id => library.get(id),
    libraryReady: () => settings.ready,
    notifyError: notify,
    now: () => Date.now(),
    prefetchEnabled: () => settings.prefetch,
    prefetchTrack,
    probe,
    recordPlay,
    resolveStreamUrl: resolve,
    storage,
    subscribeLibrary: l => {
      libListeners.add(l);
      return () => void libListeners.delete(l);
    },
    ...over,
  };
  const ctl = new PlayerController(deps);
  return {
    changeLibrary: () => libListeners.forEach(l => l()),
    ctl,
    deps,
    engine,
    libListeners,
    library,
    notify,
    prefetchTrack,
    probe,
    recordPlay,
    resolve,
    settings,
    storage,
  };
}

export const queue = (s: Setup) => [...s.library.values()];
