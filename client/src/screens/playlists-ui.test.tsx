import * as Ariakit from '@ariakit/react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToPlaylistDialog } from '@/components/playlists/add-to-playlist-dialog';
import { TrackMenu } from '@/components/player/track-menu';
import { ApiError } from '@/lib/api/errors';
import * as playlistsApi from '@/lib/api/playlists';
import { appData } from '@/lib/app-data';
import { resetPlayer, toPlayerTrack } from '@/lib/player';
import {
  makeAlbum,
  makeArtist,
  makePlaylist,
  makePlaylistTrack,
  makeTrack,
  resetFactories,
} from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { installTestPlayer } from '@/test/player-ui';
import { renderRoutes, renderWithProviders } from '@/test/render';
import { seed, seedNothing } from '@/test/seed';
import { LibraryScreen } from './library/library';
import { PlaylistScreen } from './playlist';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/playlists', async importOriginal => ({
  ...(await importOriginal<typeof playlistsApi>()),
  addPlaylistTrackRequest: vi.fn(),
  createPlaylistRequest: vi.fn(),
  deletePlaylistRequest: vi.fn(),
  removePlaylistTrackRequest: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const api = {
  add: vi.mocked(playlistsApi.addPlaylistTrackRequest),
  create: vi.mocked(playlistsApi.createPlaylistRequest),
  del: vi.mocked(playlistsApi.deletePlaylistRequest),
  remove: vi.mocked(playlistsApi.removePlaylistTrackRequest),
};

let restore: () => void;
beforeEach(() => {
  resetFactories();
  vi.clearAllMocks();
  restore = mockLayout({ height: 2000, width: 1000 });
  api.add.mockResolvedValue(undefined);
  api.del.mockResolvedValue(undefined);
  api.remove.mockResolvedValue(undefined);
  api.create.mockImplementation(async name => ({ created_at: '2026-06-01T00:00:00Z', id: 77, name }));
  seed({
    albums: [makeAlbum({ artist_id: 1, cover_url: 'https://coverartarchive.org/release-group/a/front', id: 2, title: 'Alb' })],
    artists: [makeArtist({ id: 1, name: 'Art' })],
    playlistTracks: [
      makePlaylistTrack({ id: 1, playlist_id: 5, track_id: 11 }),
      makePlaylistTrack({ id: 2, playlist_id: 5, track_id: 12 }),
    ],
    playlists: [
      makePlaylist({ id: 5, last_used_at: '2026-03-01T00:00:00Z', name: 'Дорога' }),
      makePlaylist({ id: 6, last_used_at: '2026-04-01T00:00:00Z', name: 'Фокус' }),
    ],
    tracks: [
      makeTrack({ album_id: 2, artist_id: 1, duration_ms: 60_000, id: 11, position: 1, status: 'ready', title: 'Song One' }),
      makeTrack({ album_id: 2, artist_id: 1, duration_ms: 90_000, id: 12, position: 2, status: 'found', title: 'Song Two' }),
      makeTrack({ album_id: 2, artist_id: 1, id: 13, position: 3, status: 'not_found', title: 'Missing' }),
      makeTrack({ album_id: 2, artist_id: 1, id: 14, position: 4, needs_confirmation: true, title: 'Doubtful' }),
    ],
  });
});
afterEach(() => {
  restore();
  resetPlayer(true);
});

const routes = [
  {
    element: (
      <ScrollHost>
        <LibraryScreen />
      </ScrollHost>
    ),
    path: '/library/:tab?',
  },
  {
    element: (
      <ScrollHost>
        <PlaylistScreen />
      </ScrollHost>
    ),
    path: '/playlist/:id',
  },
];
const rowIds = () => screen.getAllByTestId('track-row').map(r => r.getAttribute('data-track-id'));

describe('вкладка «Плейлисты»', () => {
  it('порядок по last_used_at, счётчик во вкладке; «Любимого» без прослушиваний нет', () => {
    renderRoutes(routes, '/library/playlists');
    const cards = screen.getAllByTestId('playlist-card');
    expect(cards.map(c => c.getAttribute('data-playlist-id'))).toEqual(['6', '5']);
    expect(screen.getByTestId('tab-playlists')).toHaveTextContent('Плейлисты 2');
    expect(within(cards[1]!).getByText('2 трека')).toBeInTheDocument();
  });

  it('«Любимое» первым и обновляется после прослушивания', () => {
    renderRoutes(routes, '/library/playlists');
    act(() => appData().library.getState().patchTrack(12, { play_count: 4 }));
    const cards = screen.getAllByTestId('playlist-card');
    expect(cards[0]).toHaveAttribute('data-playlist-id', 'favorites');
    expect(within(cards[0]!).getByText('Любимое')).toBeInTheDocument();
    expect(cards[0]).toHaveAttribute('href', '/playlist/favorites');
  });

  it('пусто: подсказка', () => {
    seed({});
    renderRoutes(routes, '/library/playlists');
    expect(screen.getByText('Плейлистов пока нет')).toBeInTheDocument();
  });

  it('быстрый фильтр сужает список; ничего не подходит — сообщение', async () => {
    renderRoutes(routes, '/library/playlists?q=фок');
    expect(screen.getAllByTestId('playlist-card')).toHaveLength(1);
    expect(screen.queryByText('Дорога')).not.toBeInTheDocument();
    renderRoutes(routes, '/library/playlists?q=zzz');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('фильтра по статусу на вкладке нет', () => {
    renderRoutes(routes, '/library/playlists');
    expect(screen.queryByRole('group', { name: 'Фильтр по статусу' })).not.toBeInTheDocument();
  });

  it('«Новый плейлист»: ожидание в форме, после ответа — переход на страницу плейлиста', async () => {
    let release!: () => void;
    api.create.mockImplementation(
      name =>
        new Promise(resolve => {
          release = () => resolve({ created_at: '2026-06-01T00:00:00Z', id: 77, name });
        }),
    );
    const { router } = renderRoutes(routes, '/library/playlists');
    await userEvent.click(screen.getByTestId('new-playlist'));
    const form = await screen.findByTestId('new-playlist-form');
    expect(within(form).getByRole('button', { name: 'Создать' })).toBeDisabled();
    await userEvent.type(within(form).getByRole('textbox'), '  Утро ');
    await userEvent.click(within(form).getByRole('button', { name: 'Создать' }));
    // До ответа сервера плейлиста в store ещё нет (временных id не вводим).
    expect(appData().library.getState().playlists.size).toBe(2);
    expect(within(form).getByRole('button', { name: 'Создать' })).toBeDisabled();
    act(() => release());
    await waitFor(() => expect(router.state.location.pathname).toBe('/playlist/77'));
    expect(api.create).toHaveBeenCalledWith('Утро');
    expect(appData().library.getState().playlists.get(77)?.name).toBe('Утро');
    expect(await screen.findByTestId('playlist-title')).toHaveTextContent('Утро');
    expect(screen.getByText('Плейлист пуст. Добавляйте треки через меню трека.')).toBeInTheDocument();
  });

  it('ошибка создания: toast, окно остаётся, store не изменился', async () => {
    api.create.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    renderRoutes(routes, '/library/playlists');
    await userEvent.click(screen.getByTestId('new-playlist'));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Название плейлиста' }), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(appData().library.getState().playlists.size).toBe(2);
    expect(screen.getByTestId('new-playlist-form')).toBeInTheDocument();
  });
});

function Picker({ trackId }: { trackId: number }) {
  const store = Ariakit.useDialogStore({ defaultOpen: true });
  return <AddToPlaylistDialog store={store} title="Song" trackId={trackId} />;
}

describe('диалог «Добавить в плейлист»', () => {
  it('плейлисты по недавности; у уже содержащего трек — отметка', async () => {
    renderWithProviders(<Picker trackId={11} />);
    const items = within(await screen.findByTestId('playlist-picker')).getAllByRole('button');
    expect(items.map(b => b.textContent)).toEqual([expect.stringContaining('Фокус'), expect.stringContaining('Дорога')]);
    expect(within(items[0]!).queryByTestId('already-added')).not.toBeInTheDocument();
    expect(within(items[1]!).getByTestId('already-added')).toBeInTheDocument();
  });

  it('выбор плейлиста: оптимистичное добавление, toast, окно закрывается', async () => {
    renderWithProviders(<Picker trackId={13} />);
    await userEvent.click(within(await screen.findByTestId('playlist-picker')).getByRole('button', { name: /Дорога/ }));
    expect(api.add).toHaveBeenCalledWith(5, 13);
    expect(toast.success).toHaveBeenCalledWith('Добавлено в «Дорога»');
    expect(appData().library.getState().tracksByPlaylist.get(5)).toHaveLength(3);
    await waitFor(() => expect(screen.queryByTestId('playlist-picker')).not.toBeInTheDocument());
  });

  it('трек уже есть: запроса нет, «Уже в …»', async () => {
    renderWithProviders(<Picker trackId={11} />);
    await userEvent.click(within(await screen.findByTestId('playlist-picker')).getByRole('button', { name: /Дорога/ }));
    expect(api.add).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Уже в «Дорога»');
  });

  it('ошибка добавления: откат, toast, окно остаётся', async () => {
    api.add.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    renderWithProviders(<Picker trackId={13} />);
    await userEvent.click(within(await screen.findByTestId('playlist-picker')).getByRole('button', { name: /Фокус/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(appData().library.getState().tracksByPlaylist.get(6)).toBeUndefined();
    expect(screen.getByTestId('playlist-picker')).toBeInTheDocument();
  });

  it('создание из окна: новый плейлист создаётся и трек сразу попадает в него', async () => {
    renderWithProviders(<Picker trackId={13} />);
    await userEvent.click(await screen.findByTestId('picker-new-playlist'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Название плейлиста' }), 'Новый');
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith(77, 13));
    const s = appData().library.getState();
    expect(s.playlists.get(77)?.name).toBe('Новый');
    expect(s.playlistTracks.get(s.tracksByPlaylist.get(77)![0]!)?.track_id).toBe(13);
  });

  it('Escape в форме создания возвращает к списку плейлистов', async () => {
    renderWithProviders(<Picker trackId={13} />);
    await userEvent.click(await screen.findByTestId('picker-new-playlist'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Название плейлиста' }), '{Escape}');
    expect(await screen.findByTestId('picker-new-playlist')).toBeInTheDocument();
    expect(screen.getByTestId('playlist-picker')).toBeInTheDocument();
  });

  it('нет плейлистов: сразу форма создания', async () => {
    seed({ albums: [], artists: [], tracks: [makeTrack({ id: 1 })] });
    renderWithProviders(<Picker trackId={1} />);
    expect(await screen.findByTestId('new-playlist-form')).toBeInTheDocument();
    expect(screen.getByText('Плейлистов пока нет')).toBeInTheDocument();
  });

  it('без сети: понятное сообщение, состояние не изменилось', async () => {
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    renderWithProviders(<Picker trackId={13} />);
    await userEvent.click(within(await screen.findByTestId('playlist-picker')).getByRole('button', { name: /Фокус/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Нет сети — сейчас это изменить нельзя'));
    expect(api.add).not.toHaveBeenCalled();
    expect(appData().library.getState().tracksByPlaylist.get(6)).toBeUndefined();
  });
});

describe('страница плейлиста', () => {
  it('шапка, треки в порядке добавления, длительность', () => {
    renderRoutes(routes, '/playlist/5');
    expect(screen.getByTestId('playlist-title')).toHaveTextContent('Дорога');
    expect(screen.getByTestId('playlist-meta')).toHaveTextContent('2 трека · 2:30');
    expect(rowIds()).toEqual(['11', '12']);
    expect(document.title).toBe('Дорога · Nimbus');
  });

  it('«Слушать» запускает очередь из доступных треков списка', async () => {
    const env = installTestPlayer();
    renderRoutes(routes, '/playlist/5');
    await userEvent.click(screen.getByTestId('play-album'));
    expect(env.ctl.state.queue.map(t => t.id)).toEqual([11, 12]);
  });

  it('удаление трека из плейлиста через меню — оптимистично', async () => {
    renderRoutes(routes, '/playlist/5');
    const row = document.querySelector('[data-track-id="11"]') as HTMLElement;
    await userEvent.click(within(row).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Убрать из плейлиста' }));
    expect(api.remove).toHaveBeenCalledWith(5, 11);
    expect(rowIds()).toEqual(['12']);
  });

  it('500 при удалении трека: строка возвращается, toast', async () => {
    api.remove.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    renderRoutes(routes, '/playlist/5');
    const row = document.querySelector('[data-track-id="11"]') as HTMLElement;
    await userEvent.click(within(row).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Убрать из плейлиста' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(rowIds()).toEqual(['11', '12']);
  });

  it('удаление плейлиста: подтверждение, переход к вкладке плейлистов', async () => {
    const { router } = renderRoutes(routes, '/playlist/5');
    await userEvent.click(screen.getByTestId('delete-playlist'));
    expect(api.del).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Плейлист «Дорога» будет удалён/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить плейлист' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/playlists'));
    expect(api.del).toHaveBeenCalledWith(5);
    expect(appData().library.getState().playlists.has(5)).toBe(false);
    expect(screen.getAllByTestId('playlist-card')).toHaveLength(1);
  });

  it('отмена удаления: ничего не происходит', async () => {
    renderRoutes(routes, '/playlist/5');
    await userEvent.click(screen.getByTestId('delete-playlist'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отмена' }));
    expect(api.del).not.toHaveBeenCalled();
    expect(appData().library.getState().playlists.has(5)).toBe(true);
  });

  it('500 при удалении плейлиста: он возвращается в список, toast; «не найдено» не мелькает', async () => {
    let fail!: () => void;
    api.del.mockImplementation(() => new Promise((_, reject) => (fail = () => reject(new ApiError(500, 'internal', 'boom')))));
    const { router } = renderRoutes(routes, '/playlist/5');
    await userEvent.click(screen.getByTestId('delete-playlist'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить плейлист' }));
    // Запрос ещё идёт: плейлист убран, но мы уже на вкладке плейлистов, а не на экране «не найдено».
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/playlists'));
    expect(screen.queryByText('Не найдено', { selector: 'h1' })).not.toBeInTheDocument();
    expect(appData().library.getState().playlists.has(5)).toBe(false);
    act(() => fail());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(appData().library.getState().playlists.get(5)?.name).toBe('Дорога');
    expect(screen.getAllByTestId('playlist-card')).toHaveLength(2);
  });

  it('без сети удаление плейлиста: остаёмся на странице, понятное сообщение', async () => {
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    const { router } = renderRoutes(routes, '/playlist/5');
    await userEvent.click(screen.getByTestId('delete-playlist'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить плейлист' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Нет сети — сейчас это изменить нельзя'));
    expect(router.state.location.pathname).toBe('/playlist/5');
    expect(api.del).not.toHaveBeenCalled();
    expect(appData().library.getState().playlists.has(5)).toBe(true);
  });

  it('«Любимое»: треки по числу прослушиваний, без кнопки удаления и «Убрать из плейлиста»', async () => {
    act(() => {
      appData().library.getState().patchTrack(12, { play_count: 5 });
      appData().library.getState().patchTrack(11, { play_count: 2 });
    });
    renderRoutes(routes, '/playlist/favorites');
    expect(screen.getByTestId('playlist-title')).toHaveTextContent('Любимое');
    expect(rowIds()).toEqual(['12', '11']);
    expect(screen.queryByTestId('delete-playlist')).not.toBeInTheDocument();
    await userEvent.click(within(document.querySelector('[data-track-id="12"]') as HTMLElement).getByTestId('track-menu'));
    expect(screen.queryByRole('menuitem', { name: 'Убрать из плейлиста' })).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Добавить в плейлист' })).toBeInTheDocument();
  });

  it('«Любимое» без прослушиваний — пустое состояние', () => {
    renderRoutes(routes, '/playlist/favorites');
    expect(screen.getByText(/Послушайте несколько треков/)).toBeInTheDocument();
  });

  it('новое прослушивание обновляет открытое «Любимое»', () => {
    renderRoutes(routes, '/playlist/favorites');
    act(() => appData().library.getState().patchTrack(11, { play_count: 1 }));
    expect(rowIds()).toEqual(['11']);
  });

  it('дельта (трек добавлен на другом устройстве) появляется без перезагрузки', () => {
    renderRoutes(routes, '/playlist/5');
    act(() =>
      appData().library.getState().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 9, playlist_id: 5, track_id: 13 })] }),
    );
    expect(rowIds()).toEqual(['11', '12', '13']);
  });

  it('плейлист удалён на другом устройстве: «не найдено»', () => {
    renderRoutes(routes, '/playlist/5');
    act(() => appData().library.getState().applyBatch({ deleted: [{ entity: 'playlist', id: 5 }] }));
    expect(screen.getByText('Не найдено', { selector: 'h1' })).toBeInTheDocument();
  });

  it('неверный id — «не найдено»', () => {
    renderRoutes(routes, '/playlist/abc');
    expect(screen.getByText('Не найдено', { selector: 'h1' })).toBeInTheDocument();
  });

  it('до гидратации — skeleton', () => {
    seedNothing();
    renderRoutes(routes, '/playlist/5');
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
  });

  it('несуществующий числовой id', () => {
    renderRoutes(routes, '/playlist/999');
    expect(screen.getByText('Не найдено', { selector: 'h1' })).toBeInTheDocument();
  });
});

describe('меню трека', () => {
  const menuItems = async (trackId: number) => {
    await userEvent.click(within(document.querySelector(`[data-track-id="${trackId}"]`) as HTMLElement).getByTestId('track-menu'));
    return (await screen.findAllByRole('menuitem')).map(i => i.textContent);
  };

  it('трек из библиотеки: плейлист и источник', async () => {
    renderRoutes(routes, '/library/tracks');
    expect(await menuItems(11)).toEqual(['Добавить в плейлист', 'Выбрать источник']);
  });

  it('трек в плейлисте: есть «Убрать из плейлиста»', async () => {
    renderRoutes(routes, '/playlist/5');
    expect(await menuItems(11)).toEqual(['Добавить в плейлист', 'Убрать из плейлиста', 'Выбрать источник']);
  });

  it('ненайденный трек: есть «Повторить поиск»', async () => {
    renderRoutes(routes, '/library/tracks');
    expect(await menuItems(13)).toEqual(['Добавить в плейлист', 'Выбрать источник', 'Повторить поиск']);
  });

  it('пункт «Добавить в плейлист» открывает диалог выбора', async () => {
    renderRoutes(routes, '/library/tracks');
    await menuItems(12);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Добавить в плейлист' }));
    expect(await screen.findByTestId('playlist-picker')).toBeInTheDocument();
  });

  it('меню плеера: «В плейлист» первым, затем переходы и «Убрать из очереди»', async () => {
    const track = toPlayerTrack(appData().selectors.trackView(appData().library.getState(), 11)!);
    renderWithProviders(<TrackMenu queueIndex={1} track={track} />);
    await userEvent.click(screen.getByTestId('player-track-menu'));
    expect((await screen.findAllByRole('menuitem')).map(i => i.textContent)).toEqual([
      'Добавить в плейлист',
      'Перейти к альбому',
      'Перейти к артисту',
      'Убрать из очереди',
    ]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Добавить в плейлист' }));
    expect(await screen.findByTestId('playlist-picker')).toBeInTheDocument();
  });
});
