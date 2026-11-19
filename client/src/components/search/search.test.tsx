import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as searchApi from '@/lib/api/search';
import { appData } from '@/lib/app-data';
import { addingStore } from '@/lib/search/add';
import { addToHistory, readHistory } from '@/lib/search/history';
import { playRemoteApp } from '@/lib/search/play-remote';
import { SLOW_SEARCH_MS } from '@/components/search/search-results';
import { SearchScreen } from '@/screens/search';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { KID_A, OK_COMPUTER, PARANOID, RADIOHEAD, searchFixture } from '@/test/search';
import { seed } from '@/test/seed';

vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
  searchRemote: vi.fn(),
}));
const search = vi.mocked(searchApi.searchRemote);
const post = vi.mocked(searchApi.addToLibraryRequest);

const routes = [
  { element: <SearchScreen />, path: '/search' },
  { element: <p>album page</p>, path: '/album/:id' },
  { element: <p>artist page</p>, path: '/artist/:id' },
];
const open = (q = 'radiohead') => renderRoutes(routes, q ? `/search?q=${encodeURIComponent(q)}` : '/search');

const setOnline = (online: boolean) => {
  vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => void globalThis.dispatchEvent(new Event(online ? 'online' : 'offline')));
};

beforeEach(() => {
  vi.clearAllMocks();
  resetFactories();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, mbid: KID_A, title: 'Kid A' })],
    artists: [makeArtist({ id: 1, mbid: 'local-radiohead', name: 'Radiohead Tribute' })],
    tracks: [makeTrack({ album_id: 1, artist_id: 1, id: 1, title: 'Radio Ga Ga' })],
  });
  search.mockResolvedValue(searchFixture());
  post.mockResolvedValue({ id: 9, status: 'added', type: 'album' });
  vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
  vi.spyOn(toast, 'success').mockReturnValue(1);
  vi.spyOn(toast, 'error').mockReturnValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  addingStore.setState({ adding: new Map() });
});

describe('экран поиска', () => {
  it('пустой запрос: подсказка и история; чип открывает запрос, «Очистить» стирает историю', () => {
    addToHistory('björk');
    addToHistory('radiohead');
    const { router } = open('');
    expect(screen.getByText('Что хотите послушать?')).toBeInTheDocument();
    const chips = within(screen.getByTestId('search-history')).getAllByRole('link');
    expect(chips.map(c => c.textContent)).toEqual(['radiohead', 'björk']);
    fireEvent.click(chips[1]!);
    expect(router.state.location.search).toBe('?q=bj%C3%B6rk');
    expect(screen.getByRole('searchbox')).toHaveValue('björk');
    // Очистка — из пустого состояния.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.queryByTestId('search-history')).not.toBeInTheDocument();
    expect(readHistory()).toEqual([]);
  });

  it('локальные результаты видны до ответа сети, под ними — скелет', () => {
    search.mockReturnValue(new Promise(() => undefined));
    open('radio');
    const local = screen.getByTestId('search-local');
    expect(within(local).getByText('Radiohead Tribute')).toBeInTheDocument();
    expect(within(local).getByText('Radio Ga Ga')).toBeInTheDocument();
    expect(screen.getByTestId('search-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('В вашей библиотеке')).toBeInTheDocument();
  });

  it('секции MusicBrainz; результат из библиотеки — отметка и ссылка на локальную сущность, остальные — «Добавить»', async () => {
    open('radiohead');
    const albums = await screen.findByTestId('search-albums');
    const cards = within(albums).getAllByTestId('remote-album');
    expect(cards).toHaveLength(2);
    // OK Computer — нет в библиотеке; Kid A — есть (по mbid), ведёт на /album/1.
    expect(within(cards[0]!).getByRole('button', { name: 'Добавить в библиотеку' })).toBeInTheDocument();
    expect(within(cards[1]!).getByText('В библиотеке')).toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    expect(screen.getByTestId('search-artists')).toBeInTheDocument();
    expect(screen.getByTestId('search-tracks')).toBeInTheDocument();
    expect(screen.getByText('Лучший результат')).toBeInTheDocument();
  });

  it('результат в библиотеке — только отметка, без «Открыть»', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 2, id: 5, mbid: OK_COMPUTER })],
      artists: [makeArtist({ id: 2, mbid: RADIOHEAD })],
      tracks: [makeTrack({ album_id: 5, artist_id: 2, id: 8, mbid_recording: PARANOID })],
    });
    open('radiohead');
    const tracks = await screen.findByTestId('search-tracks');
    expect(within(tracks).getAllByText('В библиотеке').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
  });

  it('переход по результату запоминает запрос в истории', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 2, id: 5, mbid: OK_COMPUTER })],
      artists: [makeArtist({ id: 2, mbid: RADIOHEAD })],
    });
    open('radiohead');
    const albums = await screen.findByTestId('search-albums');
    fireEvent.click(within(within(albums).getAllByTestId('remote-album')[0]!).getAllByRole('link')[0]!);
    expect(readHistory()).toEqual(['radiohead']);
    expect(await screen.findByText('album page')).toBeInTheDocument();
  });

  it('локальный артист ведёт на свою страницу и тоже запоминает запрос', () => {
    search.mockReturnValue(new Promise(() => undefined));
    const { router } = open('radio');
    fireEvent.click(screen.getByRole('link', { name: /Radiohead Tribute/ }));
    expect(router.state.location.pathname).toBe('/artist/1');
    expect(readHistory()).toEqual(['radio']);
  });

  it('нажатие на локальный трек запускает его (а не открывает альбом) и запоминает запрос', () => {
    search.mockReturnValue(new Promise(() => undefined));
    const play = vi.spyOn(playRemoteApp(), 'playRemote').mockImplementation(() => undefined);
    const { router } = open('radio');
    fireEvent.click(screen.getByRole('button', { name: /Radio Ga Ga/ }));
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Radio Ga Ga', trackId: 1 }),
      expect.any(Function),
    );
    expect(router.state.location.pathname).toBe('/search');
    expect(readHistory()).toEqual(['radio']);
  });

  it('ввод обновляет URL (replace) и запрос; пустой ввод возвращает подсказку', async () => {
    vi.useFakeTimers();
    const { router } = open('');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Kid' } });
    expect(router.state.location.search).toBe('?q=Kid');
    expect(screen.getByTestId('search-local')).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(search).toHaveBeenCalledWith('kid', expect.anything());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(router.state.location.search).toBe('');
    expect(screen.getByTestId('search-idle')).toBeInTheDocument();
  });

  it('нет результатов', async () => {
    search.mockResolvedValue(searchFixture({ albums: [], artists: [], query: 'zzzz', tracks: [] }));
    seed();
    open('zzzz');
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
    expect(screen.getByText('По запросу «zzzz» ничего нет.')).toBeInTheDocument();
  });

  it('ошибка сети: сообщение и «Повторить», локальные результаты на месте', async () => {
    search.mockRejectedValueOnce(new ApiError(400, 'bad_query', 'oops'));
    open('radio');
    expect(await screen.findByText('Поиск не удался')).toBeInTheDocument();
    expect(screen.getByText('Radiohead Tribute')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('search-results')).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('MusicBrainz не ответил ни по одной секции: не ошибка, а статус «повторяем» — и сам дозапрашивает', async () => {
    search
      .mockResolvedValueOnce(
        searchFixture({ albums: [], artists: [], errors: ['artists: timeout', 'albums: timeout'], tracks: [] }),
      )
      .mockResolvedValueOnce(searchFixture());
    open('radio');
    expect(await screen.findByText('MusicBrainz не ответил — повторяем запрос…')).toBeInTheDocument();
    expect(screen.getByTestId('search-progress')).toHaveAttribute('data-retrying', 'true');
    expect(screen.queryByText('Ничего не найдено')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Radiohead Tribute')).toBeInTheDocument();
    // Повтор без участия пользователя: только упавшие секции.
    expect(await screen.findByTestId('search-results', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(search.mock.calls[1]?.[3]).toEqual(['album', 'artist']);
    expect(screen.queryByTestId('search-progress')).not.toBeInTheDocument();
  });

  it('часть секций не ответила — результаты видны, статус «догружаем», без текста ошибки', async () => {
    search
      .mockResolvedValueOnce(searchFixture({ errors: ['tracks: timeout'] }))
      .mockReturnValue(new Promise(() => undefined));
    open('radiohead');
    expect(await screen.findByText(/Часть результатов ещё загружается/)).toBeInTheDocument();
    expect(screen.queryByText(/timeout/)).not.toBeInTheDocument();
    expect(screen.getByTestId('search-albums')).toBeInTheDocument();
  });

  it('загрузка: статус словами; через пару секунд — пояснение, что MusicBrainz медленный', () => {
    vi.useFakeTimers();
    search.mockReturnValue(new Promise(() => undefined));
    open('radio');
    const progress = screen.getByTestId('search-progress');
    expect(progress).toHaveAttribute('role', 'status');
    expect(progress).toHaveTextContent('Ищем в MusicBrainz…');
    expect(progress).not.toHaveTextContent('несколько секунд');
    act(() => void vi.advanceTimersByTime(SLOW_SEARCH_MS));
    expect(screen.getByTestId('search-progress')).toHaveTextContent('MusicBrainz может отвечать несколько секунд.');
  });

  it('офлайн: только локальные результаты и пояснение, сети нет', () => {
    setOnline(false);
    open('radio');
    expect(screen.getByTestId('search-offline')).toBeInTheDocument();
    expect(screen.getByText('Radiohead Tribute')).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByTestId('search-skeleton')).not.toBeInTheDocument();
  });

  it('офлайн и локально пусто — «ничего не найдено»', () => {
    setOnline(false);
    seed();
    open('radio');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('один символ: сеть не трогается; нет локальных совпадений — «ничего не найдено»', () => {
    seed();
    open('q');
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('новый запрос: прежние результаты сразу убираются, видна загрузка', async () => {
    const { router } = open('radiohead');
    await screen.findByTestId('search-results');
    search.mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'radiohead live' } });
    expect(screen.queryByTestId('search-results')).not.toBeInTheDocument();
    expect(screen.getByTestId('search-progress')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?q=radiohead+live');
  });

  it('ссылка меняет ?q= снаружи — поле следует за ней', () => {
    const { router } = open('radio');
    act(() => void router.navigate('/search?q=bjork'));
    expect(screen.getByRole('searchbox')).toHaveValue('bjork');
  });

  it('автофокус только на устройствах с точным указателем', () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: () => undefined,
      matches: true,
      removeEventListener: () => undefined,
    }));
    open('');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('без поддержки matchMedia автофокуса нет', () => {
    vi.stubGlobal('matchMedia', undefined);
    open('');
    expect(screen.getByRole('searchbox')).not.toHaveFocus();
  });
});

describe('кнопка «Добавить в библиотеку»', () => {
  it('цикл: добавить → «добавляется» → сущность появилась → «В библиотеке»', async () => {
    open('radiohead');
    const card = (await screen.findAllByTestId('remote-album'))[0]!;
    fireEvent.click(within(card).getByRole('button', { name: 'Добавить в библиотеку' }));
    expect(post).toHaveBeenCalledWith({ mbid: OK_COMPUTER, type: 'album' });
    // Сразу — в списке добавляемого (для «Недавно добавленных» и библиотеки), с данными из поиска.
    expect(addingStore.getState().adding.get(OK_COMPUTER)?.preview?.title).toBe('OK Computer');
    const adding = await within(card).findByRole('button', { name: 'Добавляется…' });
    expect(adding).toBeDisabled();
    expect(appData().engine.requestSync).toHaveBeenCalledWith('add');
    expect(readHistory()).toEqual(['radiohead']);
    // Дельта принесла альбом.
    act(() =>
      appData()
        .library.getState()
        .applyBatch({ albums: [makeAlbum({ artist_id: 1, id: 7, mbid: OK_COMPUTER })] }),
    );
    expect(await within(card).findByText('В библиотеке')).toBeInTheDocument();
    expect(addingStore.getState().adding.has(OK_COMPUTER)).toBe(false);
  });

  it('двойной клик — один запрос', async () => {
    post.mockReturnValue(new Promise(() => undefined));
    open('radiohead');
    const card = (await screen.findAllByTestId('remote-album'))[0]!;
    const button = within(card).getByRole('button', { name: 'Добавить в библиотеку' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ошибка: toast с переводом, кнопка в исходном состоянии', async () => {
    post.mockRejectedValue(new ApiError(404, 'mb_not_found', 'raw'));
    open('radiohead');
    const card = (await screen.findAllByTestId('remote-album'))[0]!;
    fireEvent.click(within(card).getByRole('button', { name: 'Добавить в библиотеку' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не найдено в MusicBrainz'));
    expect(within(card).getByRole('button', { name: 'Добавить в библиотеку' })).toBeEnabled();
  });

  it('состояние «добавляется» переживает размонтирование', async () => {
    post.mockReturnValue(new Promise(() => undefined));
    const first = open('radiohead');
    const card = (await screen.findAllByTestId('remote-album'))[0]!;
    fireEvent.click(within(card).getByRole('button', { name: 'Добавить в библиотеку' }));
    first.unmount();
    open('radiohead');
    const again = (await screen.findAllByTestId('remote-album'))[0]!;
    expect(within(again).getByRole('button', { name: 'Добавляется…' })).toBeDisabled();
  });

  it('добавление трека и артиста уходит с нужными полями', async () => {
    open('radiohead');
    const track = (await screen.findAllByTestId('remote-track'))[0]!;
    fireEvent.click(within(track).getByRole('button', { name: 'Добавить в библиотеку' }));
    expect(post).toHaveBeenCalledWith({ albumMbid: OK_COMPUTER, mbid: PARANOID, type: 'track' });
    expect(addingStore.getState().adding.get(PARANOID)).toMatchObject({
      preview: { artistName: 'Radiohead' },
      type: 'track',
    });
    const artist = screen.getAllByTestId('remote-artist')[0]!;
    fireEvent.click(within(artist).getByRole('button', { name: 'Добавить в библиотеку' }));
    expect(post).toHaveBeenCalledWith({ mbid: RADIOHEAD, type: 'artist' });
  });
});
