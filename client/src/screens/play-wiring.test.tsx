import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as LibraryApi from '@/lib/api/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlayer } from '@/lib/player';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { installTestPlayer } from '@/test/player-ui';
import { mockLayout, ScrollHost } from '@/test/layout';
import { renderRoutes } from '@/test/render';
import { seed } from '@/test/seed';
import { Home } from './home';
import { AlbumScreen } from './library/album';
import { ArtistScreen } from './library/artist';
import { LibraryScreen } from './library/library';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof LibraryApi>()),
  getArtistImport: vi.fn(async () => null),
}));

const routes = [
  { element: <Home />, path: '/' },
  { element: <AlbumScreen />, path: '/album/:id' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <LibraryScreen />, path: '/library/:tab?' },
];

beforeEach(() => {
  resetFactories();
  seed({
    albums: [
      makeAlbum({ artist_id: 1, id: 1, title: 'Alb' }),
      makeAlbum({ artist_id: 1, id: 2, title: 'Second', year: 2010 }),
    ],
    artists: [makeArtist({ id: 1, name: 'Art' })],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, id: 10, position: 1, status: 'ready', title: 'One' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 11, position: 2, status: 'adding', title: 'Two' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 12, position: 3, status: 'found', title: 'Three' }),
      makeTrack({ album_id: 2, artist_id: 1, id: 20, position: 1, status: 'ready', title: 'Other' }),
    ],
  });
});
afterEach(() => resetPlayer(true));

const queueIds = (env: ReturnType<typeof installTestPlayer>) => env.ctl.state.queue.map(t => t.id);

describe('кнопки воспроизведения на экранах', () => {
  it('альбом: «Слушать альбом» и строки — очередь из доступных треков альбома', async () => {
    const env = installTestPlayer();
    renderRoutes(routes, '/album/1');
    await userEvent.click(await screen.findByTestId('play-album'));
    expect(queueIds(env)).toEqual([10, 12]);
    const row = document.querySelector('[data-track-id="12"]') as HTMLElement;
    await userEvent.click(within(row).getByTestId('play-track'));
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(12);
    expect(row).toHaveAttribute('data-current', 'true');
    const unavailable = document.querySelector('[data-track-id="11"]') as HTMLElement;
    expect(within(unavailable).getByTestId('play-track')).toBeDisabled();
  });

  it('артист: «Слушать» играет треки всех альбомов библиотеки по порядку, карточки альбомов — свою очередь', async () => {
    const env = installTestPlayer();
    renderRoutes(routes, '/artist/1');
    await userEvent.click(await screen.findByTestId('play-artist'));
    expect(queueIds(env)).toEqual([10, 12, 20]);
    act(() => env.ctl.cancel());
    const cards = screen.getAllByTestId('play-album-card');
    await userEvent.click(cards[1]);
    expect(queueIds(env)).toEqual([20]);
  });

  it('библиотека: вкладка треков — очередь из списка; вкладка альбомов — кнопка на карточке', async () => {
    const restore = mockLayout({ height: 2000, width: 1000 });
    try {
      const env = installTestPlayer();
      const { router } = renderRoutes(
        [
          {
            element: (
              <ScrollHost>
                <LibraryScreen />
              </ScrollHost>
            ),
            path: '/library/:tab?',
          },
        ],
        '/library/tracks',
      );
      const row = document.querySelector('[data-track-id="20"]') as HTMLElement;
      await userEvent.click(within(row).getByTestId('play-track'));
      expect(queueIds(env).sort((a, b) => a - b)).toEqual([10, 12, 20]);
      expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(20);
      act(() => void router.navigate('/library/albums'));
      const cards = await screen.findAllByTestId('play-album-card');
      await userEvent.click(cards[0]);
      expect(env.ctl.state.queue.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
