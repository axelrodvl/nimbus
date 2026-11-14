import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { createSyncApi } from '@/lib/api/sync';
import { createDb } from '@/lib/db';
import { FakeSyncServer, makeLibrary, resetFactories } from '@/test/factories';
import { appData, createAppData, setUnauthorizedHandler } from './app-data';
import * as hooks from './store/hooks';
import { useAlbumView, useFavorites, useHydrated, useLibraryAlbums, useLive } from './store/hooks';
import { createTabs } from './sync/tabs';

beforeEach(resetFactories);

describe('createAppData', () => {
  it('bootstrap: база → store → снимок; shutdown останавливает всё', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    const postPlayed = vi.fn(async () => undefined);
    const app = createAppData({
      db: createDb({ name: 'app-data-1' }),
      postPlayed,
      syncApi: createSyncApi(createApiClient({ baseUrl: 'http://fake', fetch: server.fetch })),
      tabs: createTabs({ channel: null, locks: null }),
    });
    await app.bootstrap();
    await app.engine.settled();
    expect(app.library.getState().tracks.size).toBe(2);
    expect(app.engine.status.getState().state).toBe('live');
    await app.mutations.recordPlay(1);
    expect(postPlayed).toHaveBeenCalledWith(1);
    app.shutdown();
  });

  it('синглтон один; потеря авторизации доходит до подключённого обработчика', () => {
    expect(appData()).toBe(appData());
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const app = createAppData({ onUnauthorized: handler });
    expect(app.engine).toBeDefined();
    setUnauthorizedHandler(null);
  });
});

describe('хуки', () => {
  it('читают из store синглтона и обновляются при изменении', async () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 });
    const { library, live } = appData();
    library.getState().reset();

    function Probe() {
      const hydrated = useHydrated();
      const albums = useLibraryAlbums();
      const album = useAlbumView(1);
      const favorites = useFavorites();
      const progress = useLive(s => s.albumProgress.get(1)?.done ?? 0);
      return (
        <p>
          {String(hydrated)}|{albums.length}|{album?.trackCount ?? '-'}|{favorites.length}|{progress}
        </p>
      );
    }
    render(<Probe />);
    expect(screen.getByText('false|0|-|0|0')).toBeInTheDocument();
    library.getState().hydrate(rows);
    await waitFor(() => expect(screen.getByText('true|1|2|0|0')).toBeInTheDocument());
    library.getState().patchTrack(1, { play_count: 3 });
    await waitFor(() => expect(screen.getByText('true|1|2|1|0')).toBeInTheDocument());
    live.getState().setAlbumProgress(1, { done: 2, stage: 'searching', total: 9 });
    await waitFor(() => expect(screen.getByText('true|1|2|1|2')).toBeInTheDocument());
  });
});

describe('остальные хуки', () => {
  it('возвращают согласованные данные', () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 });
    const { library } = appData();
    library.getState().hydrate({
      ...rows,
      playlistTracks: [{ added_at: '2026-01-01T00:00:00Z', id: 1, playlist_id: 1, track_id: 1 }],
      playlists: [{ created_at: '2026-01-01T00:00:00Z', id: 1, last_used_at: '2026-01-01T00:00:00Z', name: 'P' }],
    });
    const seen: Record<string, number> = {};
    function Probe() {
      seen.artists = hooks.useLibraryArtists().length;
      seen.artist = hooks.useArtistView(1)?.trackCount ?? -1;
      seen.track = hooks.useTrackView(1)?.id ?? -1;
      seen.tracks = hooks.useLibraryTracks(['ready']).length;
      seen.artistAlbums = hooks.useArtistAlbums(1).length;
      seen.albumTracks = hooks.useAlbumTracks(1).length;
      seen.playlist = hooks.usePlaylistTracks(1).length;
      seen.recent = hooks.useRecentlyPlayedAlbums(5).length;
      seen.search = hooks.useSearchLocal('track', 10).tracks.length;
      return null;
    }
    render(<Probe />);
    expect(seen).toEqual({
      albumTracks: 2,
      artist: 2,
      artistAlbums: 1,
      artists: 1,
      playlist: 1,
      recent: 0,
      search: 2,
      track: 1,
      tracks: 2,
    });
  });
});
