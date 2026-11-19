import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalogApi from '@/lib/api/catalog';
import type { CatalogAlbumResponse, CatalogArtistResponse } from '@/lib/api/catalog';
import { ApiError } from '@/lib/api/errors';
import * as searchApi from '@/lib/api/search';
import type { AlbumResult } from '@/lib/api/search-types';
import { appData } from '@/lib/app-data';
import { resetPlayer, toPlayerTrack } from '@/lib/player';
import { groupDiscography } from '@/lib/search/catalog';
import { installTestPlayer } from '@/test/player-ui';
import { playRemoteApp } from '@/lib/search/play-remote';
import { SearchScreen } from '@/screens/search';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { OK_COMPUTER, PARANOID, RADIOHEAD, searchFixture } from '@/test/search';
import { seed } from '@/test/seed';
import { CatalogAlbumScreen, CatalogArtistScreen } from './catalog';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/catalog', async importOriginal => ({
  ...(await importOriginal<typeof catalogApi>()),
  fetchCatalogAlbum: vi.fn(),
  fetchCatalogArtist: vi.fn(),
}));
vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
  searchRemote: vi.fn(),
}));
const fetchArtist = vi.mocked(catalogApi.fetchCatalogArtist);
const fetchAlbum = vi.mocked(catalogApi.fetchCatalogAlbum);

const KID_A_RG = '3f0c6c1a-98a1-3d77-a3c8-5b8a2c7d9e22';
const LIVE_RG = '11111111-1111-4111-8111-111111111111';

const album = (over: Partial<AlbumResult>): AlbumResult => ({
  artist_mbid: RADIOHEAD,
  artist_name: 'Radiohead',
  cover_url: '',
  library_id: null,
  mbid: OK_COMPUTER,
  primary_type: 'Album',
  score: 100,
  secondary_types: [],
  title: 'OK Computer',
  year: 1997,
  ...over,
});

const artistResponse = (): CatalogArtistResponse => ({
  albums: [
    album({ mbid: LIVE_RG, secondary_types: ['Live'], title: 'I Might Be Wrong', year: 2001 }),
    album({ mbid: KID_A_RG, title: 'Kid A', year: 2000 }),
    album({}),
  ],
  artist: { country: 'GB', disambiguation: null, library_id: null, mbid: RADIOHEAD, name: 'Radiohead' },
});

const albumResponse = (): CatalogAlbumResponse => ({
  album: album({}),
  tracks: [
    {
      disc_no: 1,
      duration_ms: 284_000,
      library_id: null,
      mbid: 'rec-airbag',
      position: 1,
      status: null,
      title: 'Airbag',
    },
    {
      disc_no: 1,
      duration_ms: 387_000,
      library_id: null,
      mbid: PARANOID,
      position: 2,
      status: null,
      title: 'Paranoid Android',
    },
  ],
});

const routes = [
  { element: <SearchScreen />, path: '/search' },
  { element: <CatalogArtistScreen />, path: '/search/artist/:mbid' },
  { element: <CatalogAlbumScreen />, path: '/search/album/:mbid' },
  { element: <p>library album</p>, path: '/album/:id' },
  { element: <p>library artist</p>, path: '/artist/:id' },
];

const setOnline = (online: boolean) => {
  vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => void globalThis.dispatchEvent(new Event(online ? 'online' : 'offline')));
};

beforeEach(() => {
  vi.clearAllMocks();
  resetFactories();
  seed({ albums: [], artists: [], tracks: [] });
  fetchArtist.mockResolvedValue(artistResponse());
  fetchAlbum.mockResolvedValue(albumResponse());
  vi.mocked(searchApi.searchRemote).mockResolvedValue(searchFixture());
});
afterEach(() => vi.restoreAllMocks());

describe('groupDiscography', () => {
  it('разделы по типу в порядке студийные → EP → концертные → сборники → прочее; пустые пропускаются', () => {
    const groups = groupDiscography([
      album({ mbid: 'a', primary_type: 'EP' }),
      album({ mbid: 'b', secondary_types: ['Compilation'] }),
      album({ mbid: 'c' }),
      album({ mbid: 'd', primary_type: 'Broadcast' }),
      album({ mbid: 'e', secondary_types: ['Soundtrack'] }),
      album({ mbid: 'f', secondary_types: ['Live'] }),
    ]);
    expect(groups.map(g => [g.section, g.albums.map(a => a.mbid)])).toEqual([
      ['albums', ['c']],
      ['eps', ['a']],
      ['live', ['f']],
      ['compilations', ['b']],
      ['other', ['d', 'e']],
    ]);
    expect(groupDiscography([])).toEqual([]);
  });
});

describe('поиск → каталог', () => {
  it('нажатие на артиста в результатах открывает его дискографию из MusicBrainz', async () => {
    const { router } = renderRoutes(routes, '/search?q=radiohead');
    const artists = await screen.findByTestId('search-artists');
    fireEvent.click(within(artists).getAllByRole('link', { name: /Radiohead/ })[0]!);
    expect(router.state.location.pathname).toBe(`/search/artist/${RADIOHEAD}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Radiohead' })).toBeInTheDocument();
    expect(fetchArtist).toHaveBeenCalledWith(RADIOHEAD, expect.any(AbortSignal));
  });

  it('альбом не из библиотеки открывается в каталоге, из библиотеки — на её странице', async () => {
    seed({ albums: [makeAlbum({ artist_id: 1, id: 3, mbid: KID_A_RG })], artists: [makeArtist({ id: 1 })] });
    const { router } = renderRoutes(routes, '/search?q=radiohead');
    const albums = await screen.findByTestId('search-albums');
    const links = within(albums).getAllByRole('link', { name: /OK Computer|Kid A/ });
    expect(links.map(l => l.getAttribute('href'))).toEqual([`/search/album/${OK_COMPUTER}`, '/album/3']);
    fireEvent.click(links[0]!);
    expect(router.state.location.pathname).toBe(`/search/album/${OK_COMPUTER}`);
  });

  it('нажатие на трек в результатах — играть (добавить, если его нет)', async () => {
    const play = vi.spyOn(playRemoteApp(), 'playRemote').mockImplementation(() => undefined);
    renderRoutes(routes, '/search?q=radiohead');
    const tracks = await screen.findByTestId('search-tracks');
    fireEvent.click(within(tracks).getAllByRole('button', { name: /Paranoid Android/ })[0]!);
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ albumMbid: OK_COMPUTER, mbid: PARANOID, title: 'Paranoid Android' }),
      expect.any(Function),
    );
  });

  it('в поле — крестик очистки, спиннера в поле нет; индикатор поиска — под полем', async () => {
    vi.mocked(searchApi.searchRemote).mockReturnValue(new Promise(() => undefined));
    renderRoutes(routes, '/search?q=radiohead');
    expect(await screen.findByTestId('search-clear')).toBeInTheDocument();
    expect(screen.queryByTestId('search-spinner')).toBeNull();
    fireEvent.click(screen.getByTestId('search-clear'));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByTestId('search-clear')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'radiohead' } });
    expect(screen.getByTestId('search-progress')).toHaveTextContent('Ищем в MusicBrainz…');
  });
});

describe('экран артиста', () => {
  it('шапка и альбомы по разделам; альбом ведёт в каталог', async () => {
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    expect(screen.getByTestId('catalog-loading')).toHaveTextContent('Загружаем из MusicBrainz…');
    expect(await screen.findByText('GB · 3 альбома')).toBeInTheDocument();
    const studio = screen.getByTestId('catalog-albums');
    expect(
      within(studio)
        .getAllByTestId('catalog-album')
        .map(a => a.textContent),
    ).toEqual(['Kid A2000 · Альбом', 'OK Computer1997 · Альбом']);
    expect(within(screen.getByTestId('catalog-live')).getByText('I Might Be Wrong')).toBeInTheDocument();
    expect(within(studio).getAllByTestId('catalog-album')[1]).toHaveAttribute('href', `/search/album/${OK_COMPUTER}`);
    expect(screen.getByRole('button', { name: 'Добавить в библиотеку' })).toBeInTheDocument();
  });

  it('артист в библиотеке — только отметка', async () => {
    seed({ artists: [makeArtist({ id: 4, mbid: RADIOHEAD })] });
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    expect(await screen.findByTestId('in-library')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
  });

  it('нет альбомов — пустое состояние', async () => {
    fetchArtist.mockResolvedValue({ ...artistResponse(), albums: [] });
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    expect(await screen.findByText('Альбомов нет')).toBeInTheDocument();
  });

  it('нет в MusicBrainz (404) и неверный mbid — «не найдено»', async () => {
    fetchArtist.mockRejectedValue(new ApiError(404, 'mb_not_found', 'not found'));
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    expect(await screen.findByText('Не найдено в MusicBrainz')).toBeInTheDocument();
  });

  it('неверный mbid в адресе — «не найдено» без запроса', () => {
    renderRoutes(routes, '/search/artist/nope');
    expect(screen.getByText('Не найдено в MusicBrainz')).toBeInTheDocument();
    expect(fetchArtist).not.toHaveBeenCalled();
  });

  it('другая ошибка — сообщение и «Повторить»', async () => {
    fetchArtist.mockRejectedValueOnce(new ApiError(422, 'weird', 'Weird'));
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('GB · 3 альбома')).toBeInTheDocument();
  });

  it('офлайн — объяснение, сеть не трогается', () => {
    setOnline(false);
    renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    expect(screen.getByText('Нет сети')).toBeInTheDocument();
    expect(fetchArtist).not.toHaveBeenCalled();
  });

  it('открыт по ссылке — «Назад» ведёт на поиск, а не из приложения', async () => {
    const { router } = renderRoutes(routes, `/search/artist/${RADIOHEAD}`);
    await screen.findByText('GB · 3 альбома');
    fireEvent.click(screen.getByTestId('catalog-back'));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('');
  });

  it('«Назад» возвращает к поиску', async () => {
    const { router } = renderRoutes(routes, '/search?q=radiohead');
    const artists = await screen.findByTestId('search-artists');
    fireEvent.click(within(artists).getAllByRole('link', { name: /Radiohead/ })[0]!);
    await screen.findByText('GB · 3 альбома');
    fireEvent.click(screen.getByTestId('catalog-back'));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/search'));
  });
});

describe('экран альбома', () => {
  it('треклист; нажатие на трек — играть его в контексте альбома', async () => {
    const play = vi.spyOn(playRemoteApp(), 'playRemote').mockImplementation(() => undefined);
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const list = await screen.findByTestId('catalog-tracks');
    expect(within(list).getAllByTestId('catalog-track')).toHaveLength(2);
    expect(screen.getByText(/2 трека · 11:11/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: /Paranoid Android/ }));
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ wholeAlbum: false, albumMbid: OK_COMPUTER, context: 'album', mbid: PARANOID }),
      expect.any(Function),
    );
  });

  it('«Слушать альбом» — играть с первого трека, не добавляя альбом', async () => {
    const play = vi.spyOn(playRemoteApp(), 'playRemote').mockImplementation(() => undefined);
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    fireEvent.click(await screen.findByTestId('catalog-play-album'));
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ mbid: 'rec-airbag', title: 'OK Computer', wholeAlbum: true }),
      expect.any(Function),
    );
  });

  it('play_album_button_shows_pending: ожидание альбома — aria-busy; повторное нажатие отменяет с toast', async () => {
    const info = vi.spyOn(toast, 'info').mockReturnValue(1);
    vi.spyOn(toast, 'dismiss').mockReturnValue(1);
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const button = await screen.findByTestId('catalog-play-album');
    expect(button).not.toHaveAttribute('aria-busy');
    act(() =>
      playRemoteApp().store.setState({
        pending: {
          albumId: 5,
          origin: '/',
          request: { albumMbid: OK_COMPUTER, mbid: 'rec-airbag', title: 'OK Computer', wholeAlbum: true },
          retrying: false,
          searched: false,
          searching: new Set(),
          seen: false,
          stale: null,
          staleViews: new Set(),
          startedAt: 0,
          trackId: null,
          trackIds: [],
        },
      }),
    );
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(playRemoteApp().store.getState().pending).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 3000 }));
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });

  it('альбом и трек в библиотеке — отметки и ссылки; артист — в каталог', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 5, mbid: OK_COMPUTER })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 5, artist_id: 1, id: 8, mbid_recording: PARANOID })],
    });
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const list = await screen.findByTestId('catalog-tracks');
    const rows = within(list).getAllByTestId('catalog-track');
    // Весь альбом в библиотеке: отметка только сверху, без «Открыть»; на треках ничего.
    expect(screen.getAllByTestId('in-library')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    expect(within(list).queryByTestId('in-library')).not.toBeInTheDocument();
    expect(within(rows[0]!).queryByRole('button', { name: 'Добавить в библиотеку' })).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-album-artist')).toHaveAttribute('href', `/search/artist/${RADIOHEAD}`);
    // Альбом в библиотеке — «Слушать альбом» как на его экране (доступные треки), без добавления.
    expect(screen.queryByTestId('catalog-play-album')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Слушать альбом' })).toBeInTheDocument();
  });

  it('добавлен один трек — отметка только на треке, без «Открыть»; у альбома «Добавить»', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 5, in_library: false, mbid: OK_COMPUTER })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 5, artist_id: 1, id: 8, mbid_recording: PARANOID })],
    });
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const list = await screen.findByTestId('catalog-tracks');
    const rows = within(list).getAllByTestId('catalog-track');
    expect(within(rows[1]!).getByTestId('in-library')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Добавить в библиотеку' })).toBeInTheDocument();
    expect(screen.getAllByTestId('in-library')).toHaveLength(1);
  });

  it('несколько дисков — заголовки дисков; пустой треклист — пустое состояние', async () => {
    const data = albumResponse();
    data.tracks[1] = { ...data.tracks[1]!, disc_no: 2, position: 1 };
    fetchAlbum.mockResolvedValueOnce(data);
    const { unmount } = renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    expect(await screen.findByText('Диск 2')).toBeInTheDocument();
    unmount();
    fetchAlbum.mockResolvedValueOnce({ ...albumResponse(), tracks: [] });
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    expect(await screen.findByText('Треков нет')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-play-album')).not.toBeInTheDocument();
  });
  it('та же запись в библиотеке на другом альбоме — у трека этого альбома остаётся «Добавить»', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 6, mbid: 'other-single' })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 6, artist_id: 1, id: 60, mbid_recording: PARANOID })],
    });
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const rows = within(await screen.findByTestId('catalog-tracks')).getAllByTestId('catalog-track');
    expect(within(rows[1]!).getByRole('button', { name: 'Добавить в библиотеку' })).toBeInTheDocument();
  });

  it('трек играет, не будучи в библиотеке, — строка показывает «играет»', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 5, in_library: false, mbid: OK_COMPUTER })],
      artists: [makeArtist({ id: 1, in_library: false })],
      tracks: [
        makeTrack({ album_id: 5, artist_id: 1, id: 8, in_library: false, mbid_recording: PARANOID, status: 'found' }),
      ],
    });
    const env = installTestPlayer();
    const view = appData().selectors.trackView(appData().library.getState(), 8)!;
    act(() => env.ctl.play(toPlayerTrack(view)));
    renderRoutes(routes, `/search/album/${OK_COMPUTER}`);
    const rows = within(await screen.findByTestId('catalog-tracks')).getAllByTestId('catalog-track');
    expect(within(rows[1]!).getByTestId('remote-play')).toHaveAttribute('data-playing', 'true');
    expect(within(rows[0]!).getByTestId('remote-play')).not.toHaveAttribute('data-playing');
    // И в библиотеке он по-прежнему не числится.
    expect(within(rows[1]!).getByRole('button', { name: 'Добавить в библиотеку' })).toBeInTheDocument();
    resetPlayer(true);
  });
});
