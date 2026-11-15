import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as acquisitionApi from '@/lib/api/acquisition';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { resetPlayer } from '@/lib/player';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { installTestPlayer } from '@/test/player-ui';
import { renderRoutes } from '@/test/render';
import { seed } from '@/test/seed';
import { AlbumScreen } from './library/album';
import { LibraryScreen } from './library/library';
import { PlaylistScreen } from './playlist';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/acquisition', async importOriginal => ({
  ...(await importOriginal<typeof acquisitionApi>()),
  getAcquisition: vi.fn(async () => null),
  getAcquisitionSummary: vi.fn(async () => null),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

let ui: OfflineUi;
let restore: () => void;
const DONE = fileStatus('done', 1024, 1024);

/** Альбом 1 (треки 1–2, артист 1), альбом 2 (трек 3, артист 2), плейлист 5 (треки 1 и 3); у трека 1 есть прослушивания. */
function library() {
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Alpha' }), makeAlbum({ artist_id: 2, id: 2, title: 'Beta' })],
    artists: [makeArtist({ id: 1, name: 'Ann' }), makeArtist({ id: 2, name: 'Bob' })],
    playlistTracks: [
      makePlaylistTrack({ id: 1, playlist_id: 5, track_id: 1 }),
      makePlaylistTrack({ id: 2, playlist_id: 5, track_id: 3 }),
    ],
    playlists: [makePlaylist({ id: 5, name: 'Mix' })],
    tracks: [
      makeTrack({ album_id: 1, artist_id: 1, id: 1, play_count: 2, position: 1, status: 'ready', title: 'One' }),
      makeTrack({ album_id: 1, artist_id: 1, id: 2, position: 2, status: 'ready', title: 'Two' }),
      makeTrack({ album_id: 2, artist_id: 2, id: 3, position: 1, status: 'ready', title: 'Three' }),
    ],
  });
}

const goOffline = () => {
  vi.stubGlobal('navigator', { ...navigator, onLine: false });
  act(() => void globalThis.dispatchEvent(new Event('offline')));
};

beforeEach(() => {
  resetFactories();
  vi.clearAllMocks();
  restore = mockLayout({ height: 2000, width: 1000 });
  library();
  ui = installOfflineUi();
});
afterEach(async () => {
  restore();
  installOffline(null);
  resetPlayer();
  await resetAppData(true);
});

const lib = (route: string) =>
  renderRoutes(
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
    route,
  );

describe('библиотека без сети', () => {
  it('альбомы без скачанного приглушены, с скачанным — нет; в сети — не приглушены', () => {
    lib('/library/albums');
    const cards = () => screen.getAllByTestId('album-card').map(c => c.querySelector('a'));
    expect(cards().every(a => !a?.hasAttribute('data-dimmed'))).toBe(true);
    goOffline();
    expect(cards().every(a => a?.hasAttribute('data-dimmed'))).toBe(true);
    ui.set({ 1: DONE });
    const alpha = cards().find(a => a?.textContent?.includes('Alpha'));
    const beta = cards().find(a => a?.textContent?.includes('Beta'));
    expect(alpha).not.toHaveAttribute('data-dimmed');
    expect(beta).toHaveAttribute('data-dimmed');
  });

  it('кнопка «Слушать» недоступна у альбома без скачанного и доступна у скачанного', () => {
    renderRoutes([{ element: <AlbumScreen />, path: '/album/:id' }], '/album/1');
    goOffline();
    expect(screen.getByTestId('play-album')).toBeDisabled();
    ui.set({ 2: DONE });
    expect(screen.getByTestId('play-album')).toBeEnabled();
  });

  it('запуск нескачанного трека объясняет причину и не играет; скачанный играет', async () => {
    installTestPlayer();
    lib('/library/tracks');
    goOffline();
    ui.set({ 2: DONE });
    const rows = screen.getAllByTestId('track-row');
    const one = rows.find(r => r.getAttribute('data-track-id') === '1') as HTMLElement;
    const two = rows.find(r => r.getAttribute('data-track-id') === '2') as HTMLElement;
    const playOne = within(one).getByTestId('play-track');
    expect(playOne).not.toBeDisabled();
    await userEvent.click(playOne);
    expect(toast.info).toHaveBeenCalledWith('Нет связи. Трек не скачан на устройство', { id: 'offline-hint' });
    // Клик по строке — то же.
    await userEvent.click(one);
    expect(toast.info).toHaveBeenCalledTimes(2);
    await userEvent.click(within(two).getByTestId('play-track'));
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it('трек в статусе «добавляется» остаётся недоступным без подсказки (дело не в связи)', () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 1 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 1, id: 9, status: 'adding' })],
    });
    lib('/library/tracks');
    goOffline();
    expect(within(screen.getByTestId('track-row')).getByTestId('play-track')).toBeDisabled();
  });
});

describe('фильтр «Только скачанные»', () => {
  const filter = () => screen.getByTestId('filter-downloaded');

  it('переключатель в адресе; в сети и без сети показывает ровно скачанные альбомы', async () => {
    ui.set({ 1: DONE, 2: DONE, 3: fileStatus('downloading', 1, 2) });
    const { router } = lib('/library/albums');
    expect(screen.getAllByTestId('album-card')).toHaveLength(2);
    await userEvent.click(filter());
    expect(router.state.location.search).toBe('?offline=1');
    const cards = screen.getAllByTestId('album-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Alpha');
    expect(filter()).toHaveAttribute('aria-current', 'true');
    // Скачался и второй — карточка появилась; «Скачать» не нужен — состояние живое.
    ui.set({ 1: DONE, 2: DONE, 3: DONE });
    expect(screen.getAllByTestId('album-card')).toHaveLength(2);
    await userEvent.click(filter());
    expect(router.state.location.search).toBe('');
  });

  it('вкладки «Треки» и «Артисты»; фильтры статуса и поиск сохраняют переключатель', async () => {
    ui.set({ 2: DONE });
    const { router } = lib('/library/tracks?offline=1');
    expect(screen.getAllByTestId('track-row').map(r => r.getAttribute('data-track-id'))).toEqual(['2']);
    await userEvent.click(screen.getByTestId('tab-artists'));
    expect(router.state.location.search).toBe('?offline=1');
    expect(screen.getAllByTestId('artist-card')).toHaveLength(1);
    expect(screen.getByTestId('artist-card')).toHaveTextContent('Ann');
    await userEvent.click(screen.getByRole('link', { name: 'Готовы к прослушиванию' }));
    expect(router.state.location.search).toBe('?status=playable&offline=1');
  });

  it('ничего не скачано — сообщение; без поддержки фильтра нет и параметр игнорируется', () => {
    const first = lib('/library/albums?offline=1');
    expect(screen.getByText('Здесь пока нет ничего, скачанного на устройство')).toBeInTheDocument();
    first.unmount();
    installOfflineUi({ supported: false });
    lib('/library/albums?offline=1');
    expect(screen.queryByTestId('filter-downloaded')).toBeNull();
    expect(screen.getAllByTestId('album-card')).toHaveLength(2);
  });

  it('вкладка «Плейлисты» без фильтров', () => {
    lib('/library/playlists');
    expect(screen.queryByTestId('filter-downloaded')).toBeNull();
  });
});

describe('шапки альбома и плейлиста', () => {
  it('альбом: кнопка «На устройство» с подписью, сводка «Скачано N из M · X»', async () => {
    renderRoutes([{ element: <AlbumScreen />, path: '/album/:id' }], '/album/1');
    const control = await screen.findByTestId('offline-control');
    expect(control).toHaveTextContent('На устройство');
    ui.set({ 1: DONE, 2: fileStatus('downloading', 512, 1024) });
    expect(screen.getByTestId('offline-summary')).toHaveTextContent('Скачано 1 из 2 · 1.5 КБ');
    await userEvent.click(within(control).getByRole('button'));
    expect(ui.manager.unpin).toHaveBeenCalledWith('album', 1);
  });

  it('плейлист: закрепляет пользовательский плейлист', async () => {
    renderRoutes([{ element: <PlaylistScreen />, path: '/playlist/:id' }], '/playlist/5');
    const control = await screen.findByTestId('offline-control');
    await userEvent.click(within(control).getByRole('button', { name: /Скачать на устройство: Mix/ }));
    expect(ui.manager.pin).toHaveBeenCalledWith('playlist', 5);
    ui.set({ 1: DONE, 3: DONE });
    await waitFor(() => expect(within(control).getByTestId('offline-summary')).toHaveTextContent('Скачано 2 из 2'));
  });

  it('«Избранное» закрепляется как playlist:0', async () => {
    renderRoutes([{ element: <PlaylistScreen />, path: '/playlist/:id' }], '/playlist/favorites');
    const control = await screen.findByTestId('offline-control');
    await userEvent.click(within(control).getByRole('button'));
    expect(ui.manager.pin).toHaveBeenCalledWith('playlist', 0);
  });

  it('пустое «Избранное» без закреплений — кнопки нет', async () => {
    seed({
      albums: [makeAlbum({ id: 1 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 1, id: 1 })],
    });
    renderRoutes([{ element: <PlaylistScreen />, path: '/playlist/:id' }], '/playlist/favorites');
    await screen.findByTestId('playlist-title');
    expect(screen.queryByTestId('offline-control')).toBeNull();
  });

  it('без поддержки в шапках ничего нет', async () => {
    installOfflineUi({ supported: false });
    renderRoutes([{ element: <AlbumScreen />, path: '/album/:id' }], '/album/1');
    await screen.findByTestId('album-tracks');
    expect(screen.queryByTestId('offline-control')).toBeNull();
    expect(screen.queryByTestId('track-offline')).toBeNull();
  });

  it('строки треков показывают индикатор скачанного', async () => {
    renderRoutes([{ element: <AlbumScreen />, path: '/album/:id' }], '/album/1');
    await screen.findByTestId('album-tracks');
    ui.set({ 1: DONE });
    const indicators = screen.getAllByTestId('track-offline');
    expect(indicators).toHaveLength(1);
    expect(within(screen.getAllByTestId('track-row')[0] as HTMLElement).getByTestId('track-offline')).toBe(
      indicators[0],
    );
  });
});
