import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import * as searchApi from '@/lib/api/search';
import { NAV_ITEMS } from '@/lib/nav/items';
import { SCROLL_ROOT_ATTR } from '@/lib/nav/scroll-top';
import { SearchScreen } from '@/screens/search';
import { renderRoutes } from '@/test/render';
import { searchFixture } from '@/test/search';
import { seed } from '@/test/seed';
import {
  flushSearchSession,
  PERSIST_SCROLL_MS,
  rememberQuery,
  rememberScroll,
  reloadSearchSession,
  SESSION_KEY,
  searchHref,
  searchSession,
} from './session';

vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  searchRemote: vi.fn(),
}));

beforeEach(() => {
  reloadSearchSession();
  seed({});
  vi.mocked(searchApi.searchRemote).mockResolvedValue(searchFixture());
});

describe('сессия поиска', () => {
  it('новый запрос сбрасывает прокрутку; прокрутка запоминается для текущего', () => {
    rememberQuery('radiohead');
    rememberScroll(500);
    expect(searchSession.getState()).toEqual({ query: 'radiohead', scroll: 500 });
    rememberQuery('radiohead');
    expect(searchSession.getState().scroll).toBe(500);
    rememberQuery('muse');
    expect(searchSession.getState()).toEqual({ query: 'muse', scroll: 0 });
  });

  it('ссылка: пустой запрос — просто /search; иначе с ?q=', () => {
    expect(searchHref('')).toBe('/search');
    expect(searchHref('  ')).toBe('/search');
    expect(searchHref('ac/dc & co')).toBe('/search?q=ac%2Fdc%20%26%20co');
  });

  it('переживает перезагрузку (sessionStorage); испорченная запись — пустой поиск', () => {
    rememberQuery('björk');
    rememberScroll(120);
    flushSearchSession();
    reloadSearchSession();
    expect(searchSession.getState()).toEqual({ query: 'björk', scroll: 120 });
    sessionStorage.setItem(SESSION_KEY, '{oops');
    reloadSearchSession();
    expect(searchSession.getState()).toEqual({ query: '', scroll: 0 });
    reloadSearchSession(undefined);
    expect(searchSession.getState().query).toBe('');
  });
});

describe('возврат на поиск', () => {
  const routes = [
    {
      element: (
        <main {...{ [SCROLL_ROOT_ATTR]: '' }}>
          <SearchScreen />
          <MobileTabBar items={NAV_ITEMS} />
        </main>
      ),
      path: '/search',
    },
    {
      element: (
        <>
          <p>library page</p>
          <MobileTabBar items={NAV_ITEMS} />
        </>
      ),
      path: '/library',
    },
  ];
  const tab = (name: string) => screen.getByRole('link', { name });

  it('ушёл на другую вкладку и вернулся вкладкой «Поиск» — тот же запрос и результаты', async () => {
    const { router } = renderRoutes(routes, '/search');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'radiohead' } });
    expect(tab('Поиск')).toHaveAttribute('href', '/search?q=radiohead');
    fireEvent.click(tab('Библиотека'));
    expect(await screen.findByText('library page')).toBeInTheDocument();
    fireEvent.click(tab('Поиск'));
    expect(router.state.location.search).toBe('?q=radiohead');
    expect(screen.getByRole('searchbox')).toHaveValue('radiohead');
    expect(await screen.findByTestId('search-results')).toBeInTheDocument();
  });

  it('очищенный поиск вкладка открывает пустым', () => {
    renderRoutes(routes, '/search?q=radiohead');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(tab('Поиск')).toHaveAttribute('href', '/search');
  });

  it('прокрутка результатов запоминается, пока экран на месте', () => {
    renderRoutes(routes, '/search?q=radiohead');
    const root = document.querySelector<HTMLElement>(`[${SCROLL_ROOT_ATTR}]`)!;
    root.scrollTop = 640;
    act(() => void root.dispatchEvent(new Event('scroll')));
    expect(searchSession.getState()).toEqual({ query: 'radiohead', scroll: 640 });
  });
});

describe('запись сессии поиска', () => {
  afterEach(() => vi.useRealTimers());

  it('100 событий прокрутки за секунду — не больше 5 записей; pagehide дописывает последнее', () => {
    vi.useFakeTimers();
    rememberQuery('radiohead');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    set.mockClear();
    for (let i = 1; i <= 100; i++) {
      rememberScroll(i * 10);
      vi.advanceTimersByTime(10);
    }
    expect(set.mock.calls.length).toBeLessThanOrEqual(5);
    // Дальше — тишина, но последняя позиция ещё не записана: страницу закрывают.
    rememberScroll(5000);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!)).toEqual({ query: 'radiohead', scroll: 5000 });
    const calls = set.mock.calls.length;
    vi.advanceTimersByTime(PERSIST_SCROLL_MS * 2);
    expect(set.mock.calls.length).toBe(calls);
    set.mockRestore();
  });

  it('новый запрос записывается сразу', () => {
    rememberQuery('muse');
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!).query).toBe('muse');
  });
});

describe('экран поиска и сессия', () => {
  it('запрос в URL меняется снаружи — без предупреждений React (store обновляется в эффекте, не при рендере)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { router } = renderRoutes(
      [
        {
          element: (
            <main>
              <SearchScreen />
              <MobileTabBar items={NAV_ITEMS} />
            </main>
          ),
          path: '/search',
        },
      ],
      '/search?q=radiohead',
    );
    await act(async () => {
      await router.navigate('/search?q=muse');
    });
    expect(screen.getByRole('searchbox')).toHaveValue('muse');
    expect(screen.getByRole('link', { name: 'Поиск' })).toHaveAttribute('href', '/search?q=muse');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
