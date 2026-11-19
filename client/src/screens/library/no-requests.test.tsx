import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appData } from '@/lib/app-data';
import { LIBRARY_TABS } from '@/lib/library/tabs';
import { clearNetworkLog, networkLog } from '@/test/network';
import { makeLibrary, makePlaylist, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { seed } from '@/test/seed';
import { Home } from '../home';
import { PlaylistScreen } from '../playlist';
import { AlbumScreen } from './album';
import { ArtistScreen } from './artist';
import { LibraryScreen } from './library';

/**
 * Сторож принципа «экран библиотеки в первом кадре — только store» (`docs/DEVELOPMENT.md`, раздел про клиент;
 * ревью S11–S13). Каждый экран монтируется на заполненном store, и в первые 100 мс не должно быть ни одного
 * запроса к `/api/*`: запрос при открытии — это скачок вёрстки и лишняя нагрузка при беспорядочной навигации.
 * Картинки — не `/api` (идут через `<img>`, а не `fetch`).
 *
 * Допустимые исключения — только здесь, с причиной. Сейчас их нет: данные по требованию (источники трека, сведения
 * об аудио, каталог, поиск, «Загрузки») на этих экранах запрашиваются действием пользователя, а не при открытии.
 */
const ALLOWED: readonly { pattern: RegExp; why: string }[] = [];

const FIRST_FRAME_MS = 100;

const routes = [
  { element: <Home />, path: '/' },
  { element: <LibraryScreen />, path: '/library/:tab' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <AlbumScreen />, path: '/album/:id' },
  { element: <PlaylistScreen />, path: '/playlist/:id' },
];

beforeEach(() => {
  resetFactories();
  const rows = makeLibrary({ albumsPerArtist: 3, artists: 3, tracksPerAlbum: 4 });
  // Артист с завершённым импортом: `import = null`, а добавлен только что — раньше этого хватало для запроса.
  rows.artists[0]!.added_at = new Date().toISOString();
  rows.tracks[0]!.last_played_at = new Date().toISOString();
  rows.playlists.push(makePlaylist({ id: 1, name: 'Mix' }));
  seed(rows);
  clearNetworkLog();
});
afterEach(() => appData().socket.stop());

const apiRequests = () => networkLog.filter(r => r.includes('/api/') && !ALLOWED.some(a => a.pattern.test(r)));

async function openAndWait(route: string) {
  const view = renderRoutes(routes, route);
  await act(async () => {
    await new Promise(r => setTimeout(r, FIRST_FRAME_MS + 20));
  });
  return view;
}

describe('экраны библиотеки не ходят в сеть при открытии', () => {
  const screens: [string, string][] = [
    ['главная', '/'],
    ...LIBRARY_TABS.map(t => [`библиотека, вкладка ${t.id}`, `/library/${t.id}`] as [string, string]),
    ['артист с завершённым импортом', '/artist/1'],
    ['альбом', '/album/1'],
    ['плейлист', '/playlist/1'],
    ['избранное', '/playlist/favorites'],
  ];
  it.each(screens)('%s', async (_name, route) => {
    const view = await openAndWait(route);
    expect(view.container.innerHTML).not.toBe('');
    expect(screen.queryByTestId('screen-skeleton')).not.toBeInTheDocument();
    expect(apiRequests()).toEqual([]);
  });

  it('сам сторож видит запросы: артист с идущим импортом запрашивает подробности (осознанно, данные по требованию)', async () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 });
    rows.artists[0]!.import = 'importing';
    seed(rows);
    clearNetworkLog();
    await openAndWait('/artist/1');
    expect(apiRequests().some(r => r.includes('/api/artists/1'))).toBe(true);
  });

  it('все исключения объяснены', () => {
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(10);
  });
});
