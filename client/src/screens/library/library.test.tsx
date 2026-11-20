import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appData } from '@/lib/app-data';
import { makeLibrary, resetFactories } from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { renderRoutes } from '@/test/render';
import { seed, seedNothing, seedPhaseOne } from '@/test/seed';
import { LibraryScreen } from './library';

let restore: () => void;
beforeEach(() => {
  resetFactories();
  restore = mockLayout({ height: 2000, width: 1000 });
});
afterEach(() => restore());

function renderLibrary(route: string) {
  return renderRoutes(
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
}

const rowIds = () => screen.getAllByTestId('track-row').map(r => r.getAttribute('data-track-id'));

describe('библиотека', () => {
  it('до гидратации — skeleton', () => {
    seedNothing();
    renderLibrary('/library');
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
  });

  it('фаза 1: «Альбомы»/«Артисты» без фильтров рисуются сразу (числа во вкладках — после треков); «Треки» и фильтры — skeleton', () => {
    const rows = makeLibrary({ albumsPerArtist: 2, artists: 2, tracksPerAlbum: 2 });
    rows.albums.forEach(a => (a.in_library = true));
    seedPhaseOne(rows);
    const first = renderLibrary('/library');
    expect(within(screen.getByTestId('library-albums')).getAllByTestId('album-card')).toHaveLength(4);
    expect(screen.getByTestId('tab-albums')).toHaveTextContent(/^Альбомы\s*$/);
    first.unmount();
    renderLibrary('/library/tracks');
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
    act(() => appData().library.getState().hydrateTracks(rows.tracks));
    expect(screen.getAllByTestId('track-row').length).toBeGreaterThan(0);
  });

  it('вкладки со счётчиками; по умолчанию «Альбомы»', () => {
    seed(makeLibrary({ albumsPerArtist: 2, artists: 3, tracksPerAlbum: 4 }));
    renderLibrary('/library');
    expect(screen.getByTestId('tab-albums')).toHaveTextContent('Альбомы 6');
    expect(screen.getByTestId('tab-artists')).toHaveTextContent('Артисты 3');
    expect(screen.getByTestId('tab-tracks')).toHaveTextContent('Треки 24');
    expect(screen.getByTestId('tab-albums')).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByTestId('library-albums')).getAllByTestId('album-card')).toHaveLength(6);
  });

  it('вкладки «Артисты» и «Треки» показывают свои списки', async () => {
    seed(makeLibrary({ albumsPerArtist: 1, artists: 3, tracksPerAlbum: 2 }));
    const { router } = renderLibrary('/library/artists');
    expect(within(screen.getByTestId('library-artists')).getAllByTestId('artist-card')).toHaveLength(3);
    await userEvent.click(screen.getByTestId('tab-tracks'));
    expect(router.state.location.pathname).toBe('/library/tracks');
    expect(screen.getAllByTestId('track-row')).toHaveLength(6);
  });

  it('неизвестная вкладка → «Альбомы»', () => {
    seed(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    renderLibrary('/library/nonsense');
    expect(screen.getByTestId('tab-albums')).toHaveAttribute('aria-selected', 'true');
  });

  it('фильтр по статусу: «Готовы к прослушиванию» на вкладке треков', async () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 4 });
    ['adding', 'not_found', 'found', 'ready'].forEach((s, i) => (rows.tracks[i]!.status = s as 'adding'));
    seed(rows);
    const { router } = renderLibrary('/library/tracks');
    expect(rowIds()).toHaveLength(4);
    await userEvent.click(screen.getByRole('link', { name: 'Готовы к прослушиванию' }));
    expect(router.state.location.search).toBe('?status=playable');
    expect(rowIds().sort()).toEqual(['3', '4']);
    await userEvent.click(screen.getByRole('link', { name: 'Не найдены' }));
    expect(rowIds()).toEqual(['2']);
  });

  it('фильтр по статусу действует и на альбомы', () => {
    const rows = makeLibrary({ albumsPerArtist: 2, artists: 1, tracksPerAlbum: 1 });
    rows.tracks[0]!.status = 'adding';
    rows.tracks[1]!.status = 'ready';
    seed(rows);
    renderLibrary('/library/albums?status=adding');
    expect(within(screen.getByTestId('library-albums')).getAllByTestId('album-card')).toHaveLength(1);
  });

  it('фильтр по подстроке: состояние в URL (?q=), регистр и диакритика не важны', async () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 3 });
    rows.tracks[0]!.title = 'Élan Vital';
    rows.tracks[1]!.title = 'Другая песня';
    rows.tracks[2]!.title = 'Elan Two';
    seed(rows);
    const { router } = renderLibrary('/library/tracks');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Фильтр по названию' }), 'ELAN');
    expect(router.state.location.search).toBe('?q=ELAN');
    expect(rowIds().sort()).toEqual(['1', '3']);
    // Нажатия клавиш не засоряют историю: одна запись.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('быстрый набор на большом store не теряет символы', async () => {
    seed(makeLibrary({ albumsPerArtist: 50, artists: 20, tracksPerAlbum: 6 }));
    const { router } = renderLibrary('/library/tracks');
    const box = screen.getByRole('searchbox', { name: 'Фильтр по названию' });
    await userEvent.type(box, 'track 12 zeta', { delay: null });
    expect(box).toHaveValue('track 12 zeta');
    await waitFor(() => expect(router.state.location.search).toBe('?q=track+12+zeta'));
    expect(box).toHaveValue('track 12 zeta');
  });

  it('внешняя смена ?q= переносится в поле', async () => {
    seed(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 3 }));
    const { router } = renderLibrary('/library/tracks');
    await act(() => router.navigate('/library/tracks?q=abc'));
    expect(screen.getByRole('searchbox')).toHaveValue('abc');
    await act(() => router.navigate('/library/tracks'));
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('переключение вкладки во время набора сохраняет запрос', async () => {
    seed(makeLibrary({ albumsPerArtist: 2, artists: 2, tracksPerAlbum: 2 }));
    const { router } = renderLibrary('/library/albums');
    await userEvent.type(screen.getByRole('searchbox'), 'ab', { delay: null });
    expect(screen.getByTestId('tab-tracks')).toHaveAttribute('href', '/library/tracks?q=ab');
    await userEvent.click(screen.getByTestId('tab-tracks'));
    expect(router.state.location.pathname).toBe('/library/tracks');
    expect(router.state.location.search).toBe('?q=ab');
    expect(screen.getByRole('searchbox')).toHaveValue('ab');
  });

  it('вкладка и фильтр восстанавливаются из адреса («назад» возвращает то же)', () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 2, tracksPerAlbum: 1 });
    seed(rows);
    renderLibrary('/library/artists?q=artist%202');
    expect(screen.getByRole('searchbox')).toHaveValue('artist 2');
    expect(within(screen.getByTestId('library-artists')).getAllByTestId('artist-card')).toHaveLength(1);
    // Ссылки вкладок сохраняют фильтры.
    expect(screen.getByTestId('tab-tracks')).toHaveAttribute('href', '/library/tracks?q=artist+2');
  });

  it('ничего не подошло — пустое состояние; пустая библиотека — призыв к поиску', async () => {
    seed(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    renderLibrary('/library/tracks?q=zzzz');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('пустая библиотека — «Библиотека пуста» со ссылкой', () => {
    seed();
    renderLibrary('/library/tracks');
    expect(screen.getByText('Библиотека пуста')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Перейти к поиску' })).toBeInTheDocument();
  });

  it('статус без подходящих треков — «Нет треков с таким статусом»', () => {
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 });
    seed(rows);
    renderLibrary('/library/tracks?status=adding');
    expect(screen.getByText('Нет треков с таким статусом')).toBeInTheDocument();
  });

  it('длинный список виртуализирован: 3000 треков — в DOM лишь видимые строки', () => {
    seed(makeLibrary({ albumsPerArtist: 10, artists: 10, tracksPerAlbum: 30 }));
    renderLibrary('/library/tracks');
    expect(screen.getByTestId('tab-tracks')).toHaveTextContent('3000');
    // Окно 2000 px / 56 = 36 строк + overscan.
    expect(screen.getAllByTestId('track-row').length).toBeLessThan(60);
  });

  it('счётчики и список обновляются, когда в библиотеку приходят данные', async () => {
    seed(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    renderLibrary('/library/tracks');
    expect(screen.getAllByTestId('track-row')).toHaveLength(1);
    const { library } = appData();
    act(() => {
      library.getState().applyBatch({ tracks: [{ ...makeLibrary({ tracksPerAlbum: 1 }).tracks[0]!, id: 500 }] });
    });
    // Списки обновляются не чаще раза в 250 мс (серии событий не пересчитывают всё на каждое).
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    expect(screen.getByTestId('tab-tracks')).toHaveTextContent('2');
  });
});
