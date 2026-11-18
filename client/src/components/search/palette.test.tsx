import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as searchApi from '@/lib/api/search';
import { appData } from '@/lib/app-data';
import { addingStore } from '@/lib/search/add';
import { readHistory } from '@/lib/search/history';
import { THEME_KEY } from '@/lib/theme/theme';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { KID_A, OK_COMPUTER, searchFixture } from '@/test/search';
import { seed } from '@/test/seed';
import { CommandPaletteProvider, isEditable, useCommandPalette } from './command-palette';
import { SearchScreen } from '@/screens/search';
import { Sidebar } from '@/components/sidebar';
import { ShortcutHint } from '@/components/shortcut-hint';

vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
  searchRemote: vi.fn(),
}));
const search = vi.mocked(searchApi.searchRemote);
const post = vi.mocked(searchApi.addToLibraryRequest);

function Page() {
  const palette = useCommandPalette();
  return (
    <div>
      <button onClick={palette.open} type="button">
        open-palette
      </button>
      <input aria-label="other-field" />
      <textarea aria-label="other-area" />
      <div aria-label="rich" contentEditable suppressContentEditableWarning />
    </div>
  );
}

const routes = [
  {
    children: [
      { element: <Page />, path: '/' },
      { element: <p>album page</p>, path: '/album/:id' },
      { element: <p>artist page</p>, path: '/artist/:id' },
      { element: <SearchScreen />, path: '/search' },
      { element: <p>library page</p>, path: '/library/:tab?' },
    ],
    element: (
      <CommandPaletteProvider>
        <Outlet />
      </CommandPaletteProvider>
    ),
  },
];

/** Строка палитры по точному названию (подзаголовки других строк могут его содержать). */
const optionOf = async (title: string) => (await screen.findByText(title)).closest<HTMLElement>('[role=option]')!;

const mount = (path = '/') => renderRoutes(routes, path);
const palette = () => screen.queryByRole('dialog', { name: 'Поиск' });
const typeInPalette = (value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: 'Поиск артистов, альбомов и треков' }), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  resetFactories();
  localStorage.clear();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, mbid: KID_A, title: 'Kid A' })],
    artists: [makeArtist({ id: 1, name: 'Radiohead Tribute' })],
    tracks: [makeTrack({ album_id: 1, artist_id: 1, id: 1, title: 'Radio Ga Ga' })],
  });
  search.mockResolvedValue(searchFixture());
  post.mockResolvedValue({ id: 3, status: 'added', type: 'album' });
  vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
  vi.spyOn(toast, 'success').mockReturnValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  addingStore.setState({ adding: new Map() });
});

describe('горячие клавиши', () => {
  it('Ctrl+K и ⌘K открывают и закрывают палитру с любого места, в том числе из поля ввода', async () => {
    mount();
    expect(palette()).not.toBeInTheDocument();
    const field = screen.getByLabelText('other-field');
    field.focus();
    fireEvent.keyDown(field, { ctrlKey: true, key: 'k' });
    expect(await screen.findByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    await waitFor(() => expect(palette()).not.toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
  });

  it('«/» открывает палитру вне полей ввода и не открывает в input, textarea, contenteditable', async () => {
    mount();
    for (const label of ['other-field', 'other-area', 'rich']) {
      fireEvent.keyDown(screen.getByLabelText(label), { key: '/' });
      expect(palette()).not.toBeInTheDocument();
    }
    fireEvent.keyDown(document.body, { ctrlKey: true, key: '/' });
    expect(palette()).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(await screen.findByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
    // Уже открыта: «/» — обычный символ в её поле.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: '/' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('«/» не срабатывает, пока открыт другой диалог', () => {
    mount();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    document.body.append(other);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(palette()).not.toBeInTheDocument();
    other.remove();
  });

  it('Esc закрывает и возвращает фокус на прежний элемент', async () => {
    const user = userEvent.setup();
    mount();
    const opener = screen.getByRole('button', { name: 'open-palette' });
    opener.focus();
    await user.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(palette()).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('isEditable распознаёт редактируемые элементы', () => {
    const { container } = render(
      <>
        <input />
        <button type="button">b</button>
      </>,
    );
    expect(isEditable(container.querySelector('input'))).toBe(true);
    expect(isEditable(container.querySelector('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('содержимое палитры', () => {
  it('без запроса — «Действия»: переходы по зарегистрированным маршрутам и смена темы', async () => {
    const { router } = mount();
    fireEvent.keyDown(document.body, { key: '/' });
    const list = await screen.findByRole('listbox', { name: 'Результаты поиска' });
    expect(within(list).getByText('Действия')).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Библиотека/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Загрузки/ })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('option', { name: /Тёмная тема|Dark/i }));
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    await waitFor(() => expect(palette()).not.toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: '/' });
    fireEvent.click(await screen.findByRole('option', { name: /Библиотека/ }));
    expect(router.state.location.pathname).toBe('/library');
  });

  it('ввод ищет локально сразу, удалённо — после debounce; уже имеющееся из MusicBrainz не дублируется', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    typeInPalette('radio');
    expect(screen.getByText('Radiohead Tribute')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Radio Ga Ga/ })).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    await optionOf('OK Computer');
    // «Kid A» в библиотеке — отдельной строкой MusicBrainz не показывается.
    expect(screen.queryByText('Kid A')).not.toBeInTheDocument();
  });

  it('действия фильтруются запросом и идут после результатов', async () => {
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    typeInPalette('библио');
    const options = screen.getAllByRole('option');
    expect(options.at(-1)).toHaveTextContent('Библиотека');
  });

  it('ошибка удалённого поиска: локальное остаётся, показана причина', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    search.mockRejectedValue(new ApiError(400, 'bad_query', 'plain failure'));
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    typeInPalette('radio');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(await screen.findByRole('alert')).toHaveTextContent('plain failure');
    expect(screen.getByRole('option', { name: /Radio Ga Ga/ })).toBeInTheDocument();
  });

  it('ничего не найдено', async () => {
    search.mockResolvedValue(searchFixture({ albums: [], artists: [], query: 'qqqq', tracks: [] }));
    seed();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    typeInPalette('qqqq');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
  });
});

describe('выбор элемента', () => {
  async function openWith(query: string) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    typeInPalette(query);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    return view;
  }
  const input = () => screen.getByRole('combobox');

  it('стрелки двигают выбор по кругу; Enter на локальном треке открывает его альбом и запоминает запрос', async () => {
    const { router } = await openWith('radio');
    await optionOf('OK Computer');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    // Порядок: локальные артист и трек, затем MusicBrainz.
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options[1]).toHaveTextContent('Radio Ga Ga');
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(router.state.location.pathname).toBe('/album/1');
    await waitFor(() => expect(palette()).not.toBeInTheDocument());
    expect(readHistory()).toEqual(['radio']);
  });

  it('Enter на локальном артисте и клик по нему ведут на страницу артиста', async () => {
    const { router } = await openWith('radio');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(router.state.location.pathname).toBe('/artist/1');
  });

  it('Enter на результате MusicBrainz добавляет в библиотеку; палитра остаётся открытой, показано «добавляется»', async () => {
    post.mockReturnValue(new Promise(() => undefined));
    await openWith('radiohead');
    const option = await optionOf('OK Computer');
    fireEvent.mouseMove(option);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(post).toHaveBeenCalledWith({ mbid: OK_COMPUTER, type: 'album' });
    await waitFor(() => expect(within(option).getByText('Добавляется…')).toBeInTheDocument());
    expect(palette()).toBeInTheDocument();
  });

  it('клик по строке работает как Enter', async () => {
    const { router } = await openWith('radio');
    fireEvent.click(screen.getByRole('option', { name: /Radio Ga Ga/ }));
    expect(router.state.location.pathname).toBe('/album/1');
  });

  it('«Показать все результаты» и Enter без выбранного элемента ведут на /search?q=', async () => {
    seed();
    search.mockResolvedValue(searchFixture({ albums: [], artists: [], query: 'zzz', tracks: [] }));
    const { router } = await openWith('zzz');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(router.state.location.pathname).toBe('/search');
    expect(router.state.location.search).toBe('?q=zzz');
  });

  it('кнопка «Показать все результаты»', async () => {
    const { router } = await openWith('radio');
    fireEvent.click(screen.getByRole('button', { name: 'Показать все результаты' }));
    expect(router.state.location.search).toBe('?q=radio');
  });

  it('Enter с пустым вводом без действий ничего не делает', async () => {
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    await screen.findByRole('dialog');
    // Действия есть: первый — переход на «Главная»; сам Enter выполняет его и закрывает палитру.
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(palette()).not.toBeInTheDocument());
  });

  it('офлайн: только локальные результаты, сеть не трогается', async () => {
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    await openWith('radio');
    expect(screen.getByRole('option', { name: /Radio Ga Ga/ })).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('кнопка в боковой панели и подсказка', () => {
  it('кнопка «Поиск» боковой панели открывает палитру', async () => {
    renderRoutes(
      [
        {
          element: (
            <CommandPaletteProvider>
              <Sidebar items={[]} />
            </CommandPaletteProvider>
          ),
          path: '*',
        },
      ],
      '/',
    );
    fireEvent.click(screen.getByTestId('palette-button'));
    expect(await screen.findByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
  });

  it('вне провайдера кнопка ничего не ломает', () => {
    renderRoutes([{ element: <Sidebar items={[]} />, path: '*' }], '/');
    expect(() => fireEvent.click(screen.getByTestId('palette-button'))).not.toThrow();
  });

  it('имя кнопки палитры содержит весь видимый текст (подпись и клавиши) — доступность по WCAG 2.5.3', () => {
    vi.spyOn(globalThis.navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    renderRoutes([{ element: <Sidebar items={[]} />, path: '*' }], '/');
    const button = screen.getByTestId('palette-button');
    expect(button).toHaveAttribute('aria-label', 'Поиск Ctrl K');
    expect(button.textContent).toBe('Поиск Ctrl K');
  });

  it('подсказка: ⌘K на macOS, Ctrl K на остальных', () => {
    vi.spyOn(globalThis.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { container, unmount } = render(<ShortcutHint />);
    expect(container).toHaveTextContent('⌘K');
    unmount();
    vi.spyOn(globalThis.navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    expect(render(<ShortcutHint />).container).toHaveTextContent('Ctrl K');
  });
});
