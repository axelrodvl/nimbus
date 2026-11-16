import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as libraryApi from '@/lib/api/library';
import { appData } from '@/lib/app-data';
import { makeAlbum, makeArtist, makeLibrary, makeTrack, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { seed, seedNothing } from '@/test/seed';
import { AlbumScreen } from './album';
import { ArtistScreen, groupAlbums } from './artist';

vi.mock('@/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof libraryApi>()),
  getArtistImport: vi.fn(),
  removeFromLibraryRequest: vi.fn(),
  retryArtistImport: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const getImport = vi.mocked(libraryApi.getArtistImport);
const removeRequest = vi.mocked(libraryApi.removeFromLibraryRequest);
const retryRequest = vi.mocked(libraryApi.retryArtistImport);

beforeEach(() => {
  resetFactories();
  vi.clearAllMocks();
  getImport.mockResolvedValue(null);
});

const routes = [
  { element: <AlbumScreen />, path: '/album/:id' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <p>library page</p>, path: '/library/:tab' },
];

const imp = (over: Partial<libraryApi.ArtistImport> = {}): libraryApi.ArtistImport => ({
  attempt: 1,
  max_attempts: 8,
  state: 'importing',
  ...over,
});

describe('альбом', () => {
  function discs() {
    const artist = makeArtist({ id: 1, name: 'Radiohead' });
    const album = makeAlbum({ artist_id: 1, id: 1, primary_type: 'Album', title: 'OK Computer', year: 1997 });
    const tracks = [
      makeTrack({ album_id: 1, artist_id: 1, disc_no: 2, id: 13, position: 1, title: 'D2 first' }),
      makeTrack({ album_id: 1, artist_id: 1, disc_no: 1, id: 11, position: 1, status: 'adding', title: 'D1 first' }),
      makeTrack({ album_id: 1, artist_id: 1, disc_no: 1, id: 12, position: 2, status: 'found', title: 'D1 second' }),
    ];
    return { albums: [album], artists: [artist], tracks };
  }

  it('шапка: название, артист-ссылка, год, число треков; заголовок вкладки', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    expect(screen.getByRole('heading', { level: 1, name: 'OK Computer' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Radiohead' })[0]).toHaveAttribute('href', '/artist/1');
    expect(screen.getByText(/1997 · 3 трека/)).toBeInTheDocument();
    expect(document.title).toBe('OK Computer · Nimbus');
  });

  it('треки сгруппированы по дискам и отсортированы; заголовки дисков при нескольких дисках', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    const list = screen.getByTestId('album-tracks');
    expect(
      within(list)
        .getAllByTestId('track-row')
        .map(r => r.getAttribute('data-track-id')),
    ).toEqual(['11', '12', '13']);
    expect(within(list).getByText('Диск 1')).toBeInTheDocument();
    expect(within(list).getByText('Диск 2')).toBeInTheDocument();
  });

  it('один диск — без заголовков дисков', () => {
    const rows = discs();
    rows.tracks.forEach(t => (t.disc_no = 1));
    seed(rows);
    renderRoutes(routes, '/album/1');
    expect(screen.queryByText(/^Диск/)).not.toBeInTheDocument();
  });

  it('сводка статусов считает все статусы альбома', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    expect(screen.getByTestId('album-status-summary')).toHaveTextContent('1 ищем');
    expect(screen.getByTestId('album-status-summary')).toHaveTextContent('1 найдено');
    expect(screen.getByTestId('album-status-summary')).toHaveTextContent('1 скачано');
  });

  it('track.status меняет бейдж и сводку без перезагрузки', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    const row = () => screen.getAllByTestId('track-row').find(r => r.getAttribute('data-track-id') === '11')!;
    expect(within(row()).getByRole('img', { name: 'Ищем раздачи…' })).toBeInTheDocument();
    act(() =>
      appData().engine.handleEvent({ album_id: 1, reason: null, status: 'ready', track_id: 11, type: 'track.status' }),
    );
    expect(within(row()).getByRole('img', { name: 'Скачано' })).toBeInTheDocument();
    expect(screen.getByTestId('album-status-summary')).toHaveTextContent('2 скачано');
    act(() =>
      appData().engine.handleEvent({
        album_id: 1,
        reason: 'dead_torrents',
        status: 'not_found',
        track_id: 12,
        type: 'track.status',
      }),
    );
    expect(within(screen.getAllByTestId('track-row')[1]!).getByRole('img', { name: 'Нет сидов' })).toBeInTheDocument();
  });

  it('job.progress показывает прогресс и скрывается по завершении', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    expect(screen.queryByTestId('album-progress')).not.toBeInTheDocument();
    act(() =>
      appData().engine.handleEvent({ album_id: 1, done: 2, stage: 'verifying', total: 5, type: 'job.progress' }),
    );
    expect(screen.getByTestId('album-progress')).toHaveTextContent('Проверяем раздачи 2/5');
    // Бейдж трека в поиске показывает тот же прогресс.
    expect(screen.getByRole('img', { name: 'Проверяем раздачи 2/5' })).toBeInTheDocument();
    act(() =>
      appData().engine.handleEvent({ album_id: 1, done: 5, stage: 'verifying', total: 5, type: 'job.progress' }),
    );
    expect(screen.queryByTestId('album-progress')).not.toBeInTheDocument();
  });

  it('job.progress не показывается у альбома, где все треки уже найдены', () => {
    const d = discs();
    seed({
      ...d,
      tracks: d.tracks.map(tr => makeTrack({ ...tr, status: 'ready' })),
    });
    renderRoutes(routes, '/album/1');
    act(() =>
      appData().engine.handleEvent({ album_id: 1, done: 7, stage: 'verifying', total: 10, type: 'job.progress' }),
    );
    expect(screen.queryByTestId('album-progress')).not.toBeInTheDocument();
  });

  it('этап поиска без числа — «Ищем раздачи…»', () => {
    seed(discs());
    renderRoutes(routes, '/album/1');
    act(() =>
      appData().engine.handleEvent({ album_id: 1, done: 0, stage: 'searching', total: 0, type: 'job.progress' }),
    );
    expect(screen.getByTestId('album-progress')).toHaveTextContent('Ищем раздачи…');
  });

  it('предупреждение «источники нужно проверить» и «в библиотеке N из M» для альбома не целиком', () => {
    const rows = discs();
    rows.albums[0]!.in_library = false;
    rows.tracks[0]!.in_library = false;
    rows.tracks[1]!.needs_confirmation = true;
    seed(rows);
    renderRoutes(routes, '/album/1');
    expect(screen.getByTestId('album-needs-confirmation')).toBeInTheDocument();
    expect(screen.getByText('В библиотеке: 2 из 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
  });

  it('нет такого альбома — «не найдено»; до гидратации — skeleton', () => {
    seedNothing();
    const first = renderRoutes(routes, '/album/1');
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
    first.unmount();
    seed(discs());
    renderRoutes(routes, '/album/999');
    expect(screen.getByRole('heading', { name: 'Не найдено' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'В библиотеку' })).toHaveAttribute('href', '/library');
  });

  it('некорректный id — «не найдено»', () => {
    seed(discs());
    renderRoutes(routes, '/album/abc');
    expect(screen.getByRole('heading', { name: 'Не найдено' })).toBeInTheDocument();
  });
});

describe('удаление из библиотеки', () => {
  const library = () => {
    const rows = makeLibrary({ albumsPerArtist: 2, artists: 1, tracksPerAlbum: 2 });
    return rows;
  };
  const confirmRemoval = async () => {
    await userEvent.click(screen.getByTestId('album-menu'));
    await userEvent.click(await screen.findByTestId('album-remove'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/«Album 1» исчезнет из библиотеки/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
  };

  it('оптимистично: объект исчезает из store до ответа сервера, затем переход в библиотеку', async () => {
    seed(library());
    let finish: () => void = () => undefined;
    removeRequest.mockImplementation(() => new Promise<void>(r => (finish = r)));
    const { router } = renderRoutes(routes, '/album/1');
    await confirmRemoval();
    await waitFor(() => expect(appData().library.getState().albums.get(1)?.in_library).toBe(false));
    expect(appData().library.getState().tracks.get(1)?.in_library).toBe(false);
    expect(appData().library.getState().albums.get(2)?.in_library).toBe(true);
    expect(removeRequest).toHaveBeenCalledWith('album', 1);
    expect(router.state.location.pathname).toBe('/album/1');
    await act(async () => finish());
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/albums'));
  });

  it('при ошибке 500 — откат и toast, остаёмся на экране', async () => {
    const { toast } = await import('sonner');
    seed(library());
    removeRequest.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    const { router } = renderRoutes(routes, '/album/1');
    await confirmRemoval();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(appData().library.getState().albums.get(1)?.in_library).toBe(true);
    expect(appData().library.getState().tracks.get(1)?.in_library).toBe(true);
    expect(router.state.location.pathname).toBe('/album/1');
  });

  it('артист: убираются артист, его альбомы и треки', async () => {
    seed(library());
    removeRequest.mockResolvedValue();
    renderRoutes(routes, '/artist/1');
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(removeRequest).toHaveBeenCalledWith('artist', 1));
    const s = appData().library.getState();
    expect(s.artists.get(1)?.in_library).toBe(false);
    expect([...s.albums.values()].every(a => !a.in_library)).toBe(true);
    expect([...s.tracks.values()].every(t => !t.in_library)).toBe(true);
  });

  it('без сети — ошибка offline, store не меняется', async () => {
    const { toast } = await import('sonner');
    seed(library());
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderRoutes(routes, '/album/1');
    await confirmRemoval();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(removeRequest).not.toHaveBeenCalled();
    expect(appData().library.getState().albums.get(1)?.in_library).toBe(true);
  });
});

describe('артист', () => {
  function discography() {
    const artist = makeArtist({ id: 1, name: 'Eminem' });
    const types: [string | null, number | null, string][] = [
      ['Album', 2010, 'Recovery'],
      ['Album', 2000, 'The Marshall Mathers LP'],
      ['EP', 2005, 'Small EP'],
      ['Single', 2002, 'Lose Yourself'],
      [null, null, 'Mystery'],
    ];
    const albums = types.map(([primary_type, year, title], i) =>
      makeAlbum({ artist_id: 1, id: i + 1, primary_type, title, year }),
    );
    const tracks = albums.map(a => makeTrack({ album_id: a.id, artist_id: 1, id: a.id }));
    return { albums, artists: [artist], tracks };
  }
  const groupTitles = () => screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);

  it('шапка и группы альбомов по типу релиза; внутри — по году', () => {
    seed(discography());
    renderRoutes(routes, '/artist/1');
    expect(screen.getByRole('heading', { level: 1, name: 'Eminem' })).toBeInTheDocument();
    expect(screen.getByTestId('artist-counts')).toHaveTextContent('5 альбомов · 5 треков в библиотеке');
    expect(groupTitles()).toEqual(['Альбомы', 'EP', 'Синглы', 'Другие релизы']);
    const albums = within(screen.getByTestId('artist-group-album')).getAllByRole('link');
    expect(albums.map(a => a.textContent)).toEqual([
      expect.stringContaining('The Marshall Mathers LP'),
      expect.stringContaining('Recovery'),
    ]);
  });

  it('groupAlbums отбрасывает пустые группы', () => {
    expect(groupAlbums([])).toEqual([]);
  });

  it('нет альбомов и нет импорта — «Нет альбомов в библиотеке»', async () => {
    seed({ artists: [makeArtist({ id: 1 })] });
    renderRoutes(routes, '/artist/1');
    expect(screen.getByText('Нет альбомов в библиотеке.')).toBeInTheDocument();
  });

  it('статус не запрашивается у давно добавленного артиста с альбомами', () => {
    const rows = discography();
    rows.artists[0]!.added_at = '2020-01-01T00:00:00Z';
    seed(rows);
    renderRoutes(routes, '/artist/1');
    expect(getImport).not.toHaveBeenCalled();
  });

  it('статус запрашивается у недавно добавленного артиста', async () => {
    const rows = discography();
    rows.artists[0]!.added_at = new Date().toISOString();
    seed(rows);
    getImport.mockResolvedValue(imp({ state: 'importing' }));
    renderRoutes(routes, '/artist/1');
    expect(await screen.findByTestId('artist-import')).toHaveAttribute('data-state', 'importing');
    expect(getImport).toHaveBeenCalledWith(1);
  });

  describe('статус импорта', () => {
    beforeEach(() => seed({ artists: [makeArtist({ id: 1 })] }));

    it('importing: степпер — пройденные шаги, текущий с прогрессом, будущие', async () => {
      getImport.mockResolvedValue(
        imp({
          progress: {
            current: 'Recovery',
            done: 3,
            imported: 3,
            log: [],
            phase: 'albums',
            skipped: 0,
            total: 12,
          },
        }),
      );
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      const step = (name: string) => status.querySelector(`[data-step="${name}"]`);
      expect(step('queue')).toHaveAttribute('data-step-state', 'done');
      expect(step('groups')).toHaveAttribute('data-step-state', 'done');
      expect(step('albums')).toHaveAttribute('data-step-state', 'active');
      expect(step('discover')).toHaveAttribute('data-step-state', 'todo');
      expect(step('albums')).toHaveTextContent('Импорт альбомов');
      expect(step('albums')).toHaveTextContent('3/12');
      expect(step('albums')).toHaveTextContent('Recovery');
      expect(screen.queryByTestId('artist-import-log')).not.toBeInTheDocument();
    });

    it('importing, фаза MusicBrainz: страницы и живая подробность', async () => {
      getImport.mockResolvedValue(
        imp({
          progress: { current: 'page 2', done: 1, imported: 0, log: [], phase: 'groups', skipped: 0, total: 4 },
        }),
      );
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      expect(status.querySelector('[data-step="groups"]')).toHaveAttribute('data-step-state', 'active');
      expect(status).toHaveTextContent('Список альбомов из MusicBrainz');
      expect(status).toHaveTextContent('1/4');
      expect(screen.getByTestId('artist-import-live')).toHaveTextContent('page 2');
    });

    it('importing без прогресса: попытка > 1 и первая', async () => {
      getImport.mockResolvedValue(imp({ attempt: 2 }));
      const first = renderRoutes(routes, '/artist/1');
      expect(await screen.findByTestId('artist-import')).toHaveTextContent('попытка 2 из 8');
      first.unmount();
      getImport.mockResolvedValue(imp());
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      expect(status.querySelector('[data-step="groups"]')).toHaveAttribute('data-step-state', 'active');
    });

    it('discover: сколько добавлено', async () => {
      getImport.mockResolvedValue(
        imp({ progress: { done: 0, imported: 7, log: [], phase: 'discover', skipped: 0, total: 0 } }),
      );
      renderRoutes(routes, '/artist/1');
      expect(await screen.findByTestId('artist-import')).toHaveTextContent('7 альбомов');
    });

    it('queued: ждёт очереди', async () => {
      getImport.mockResolvedValue(imp({ state: 'queued' }));
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      expect(status).toHaveAttribute('data-state', 'queued');
      expect(status).toHaveTextContent('Ждёт своей очереди на импорт');
    });

    it('retrying: попытка и время следующей', async () => {
      getImport.mockResolvedValue(
        imp({ attempt: 2, retry_at: new Date(Date.now() + 3 * 60_000).toISOString(), state: 'retrying' }),
      );
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      expect(status).toHaveAttribute('data-state', 'retrying');
      expect(status).toHaveTextContent('MusicBrainz не отвечает');
      expect(status).toHaveTextContent('попытка 2 из 8');
      expect(status).toHaveTextContent('примерно через 3 мин');
    });

    it('failed: сообщение и «Повторить» запускает импорт заново', async () => {
      const { toast } = await import('sonner');
      getImport.mockResolvedValue(imp({ attempt: 8, error: 'MusicBrainz 503', state: 'failed' }));
      retryRequest.mockResolvedValue();
      renderRoutes(routes, '/artist/1');
      const status = await screen.findByTestId('artist-import');
      expect(status).toHaveAttribute('data-state', 'failed');
      expect(status).toHaveTextContent('Сдались после 8 попыток');
      getImport.mockResolvedValue(imp());
      await userEvent.click(within(status).getByRole('button', { name: 'Повторить' }));
      expect(retryRequest).toHaveBeenCalledWith(1);
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Импорт запущен заново'));
      await waitFor(() => expect(screen.getByTestId('artist-import')).toHaveAttribute('data-state', 'importing'));
    });

    it('failed: ошибка повтора — toast, кнопка снова доступна', async () => {
      const { toast } = await import('sonner');
      getImport.mockResolvedValue(imp({ state: 'failed' }));
      retryRequest.mockRejectedValue(new ApiError(500, 'internal', 'down'));
      renderRoutes(routes, '/artist/1');
      const button = await screen.findByRole('button', { name: 'Повторить' });
      await userEvent.click(button);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('down'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Повторить' })).toBeEnabled());
    });

    it('нет импорта — блока статуса нет', async () => {
      getImport.mockResolvedValue(null);
      renderRoutes(routes, '/artist/1');
      await waitFor(() => expect(getImport).toHaveBeenCalled());
      expect(screen.queryByTestId('artist-import')).not.toBeInTheDocument();
    });
  });

  it('нет такого артиста — «не найдено»', () => {
    seed(discography());
    renderRoutes(routes, '/artist/42');
    expect(screen.getByRole('heading', { name: 'Не найдено' })).toBeInTheDocument();
  });

  it('до гидратации — skeleton', () => {
    seedNothing();
    renderRoutes(routes, '/artist/1');
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
  });
});
