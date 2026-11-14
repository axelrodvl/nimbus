import { vi } from 'vitest';
import { PlayerController } from '@/lib/player/controller';
import { appPlayerDeps, installPlayer } from '@/lib/player';
import type { PlayerDeps } from '@/lib/player/controller';
import { makeAlbum, makeArtist, makeTrack } from './factories';
import { FakeAudioEngine } from './fake-engine';
import { MemStorage } from './player';
import { seed } from './seed';

/** Библиотека для тестов интерфейса плеера: альбом 2 артиста 1, треки 10 (ready), 11 (found), 12 (adding), 13 (found). */
export function seedPlayerLibrary(): void {
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 2, title: 'Alb' })],
    artists: [makeArtist({ id: 1, name: 'Art' })],
    tracks: [
      makeTrack({
        album_id: 2,
        artist_id: 1,
        duration_ms: 10_000,
        id: 10,
        position: 1,
        status: 'ready',
        title: 'Song One',
      }),
      makeTrack({
        album_id: 2,
        artist_id: 1,
        duration_ms: 10_000,
        id: 11,
        position: 2,
        status: 'found',
        title: 'Song Two',
      }),
      makeTrack({
        album_id: 2,
        artist_id: 1,
        duration_ms: 10_000,
        id: 12,
        position: 3,
        status: 'adding',
        title: 'Not Yet',
      }),
      makeTrack({
        album_id: 2,
        artist_id: 1,
        duration_ms: 10_000,
        id: 13,
        position: 4,
        status: 'found',
        title: 'Song Four',
      }),
    ],
  });
}

/** Контроллер приложения с фейковым движком поверх библиотеки `appData()`. */
export function installTestPlayer(over: Partial<PlayerDeps> = {}) {
  const engine = new FakeAudioEngine();
  const storage = new MemStorage();
  const prefetchTrack = vi.fn(async () => undefined);
  const ctl = new PlayerController(
    appPlayerDeps({
      engine,
      notifyError: undefined,
      prefetchTrack,
      probe: async () => ({ code: 'no_peers' }),
      recordPlay: async () => undefined,
      storage,
      ...over,
    }),
  );
  installPlayer(ctl);
  return { ctl, engine, prefetchTrack, storage };
}
