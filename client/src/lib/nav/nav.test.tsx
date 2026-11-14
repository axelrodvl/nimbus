import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppNavLink } from '@/components/app-nav-link';
import { renderRoutes } from '@/test/render';
import { hasRoute, NAV_ITEMS, visibleNavItems } from './items';
import { RESTORE_TIMEOUT_MS, useScrollRestoration } from './use-scroll-restoration';
import { useTitle } from './use-title';

describe('пункты навигации', () => {
  it('показываются только зарегистрированные маршруты; вложенные пути считаются', () => {
    expect(visibleNavItems(['/']).map(i => i.to)).toEqual(['/']);
    expect(visibleNavItems(['/', '/library/:tab', '/downloads', '/search']).map(i => i.to)).toEqual([
      '/',
      '/search',
      '/library',
      '/downloads',
    ]);
    expect(visibleNavItems([])).toEqual([]);
    expect(visibleNavItems(NAV_ITEMS.map(i => i.to))).toHaveLength(NAV_ITEMS.length);
  });

  it('корневой маршрут не «включает» все остальные, а `/library` не совпадает с `/libraryx`', () => {
    expect(hasRoute(['/library'], '/')).toBe(false);
    expect(hasRoute(['/libraryx'], '/library')).toBe(false);
    expect(hasRoute(['/settings/:section'], '/settings')).toBe(true);
  });
});

describe('AppNavLink', () => {
  it('активна на самом пути и на вложенных, но не на соседних; «/» — только точно', () => {
    const view = (
      <>
        <AppNavLink end to="/">
          home
        </AppNavLink>
        <AppNavLink to="/library">library</AppNavLink>
        <AppNavLink to="/search">search</AppNavLink>
      </>
    );
    const { router } = renderRoutes([{ element: view, path: '*' }], '/library/albums');
    expect(screen.getByText('library')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('home')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('search')).not.toHaveAttribute('aria-current');
    act(() => void router.navigate('/'));
    expect(screen.getByText('home')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('library')).not.toHaveAttribute('aria-current');
  });
});

describe('useTitle', () => {
  function T({ title }: { title?: string }) {
    useTitle(title);
    return null;
  }
  it('ставит «title · Nimbus» и возвращает «Nimbus» при размонтировании', () => {
    const { unmount, rerender } = render(<T title="Поиск" />);
    expect(document.title).toBe('Поиск · Nimbus');
    rerender(<T title="Библиотека" />);
    expect(document.title).toBe('Библиотека · Nimbus');
    unmount();
    expect(document.title).toBe('Nimbus');
    render(<T />);
    expect(document.title).toBe('Nimbus');
  });
});

describe('восстановление прокрутки', () => {
  function Layout() {
    const ref = useRef<HTMLElement>(null);
    useScrollRestoration(ref);
    const navigate = useNavigate();
    return (
      <main data-testid="scroller" ref={ref}>
        <Link to="/b">to-b</Link>
        <button onClick={() => void navigate(-1)} type="button">
          back
        </button>
        <Outlet />
      </main>
    );
  }
  function setup() {
    const router = createMemoryRouter(
      [
        {
          children: [
            { element: <p>a</p>, path: '/' },
            { element: <p>b</p>, path: '/b' },
          ],
          element: <Layout />,
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    const el = screen.getByTestId('scroller');
    // happy-dom не считает раскладку: scrollTop принимает любое значение.
    return { el, router };
  }

  it('«назад» возвращает позицию, новый переход начинает сверху', async () => {
    const { el } = setup();
    el.scrollTop = 420;
    el.dispatchEvent(new Event('scroll'));
    await act(async () => screen.getByText('to-b').click());
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 50;
    el.dispatchEvent(new Event('scroll'));
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(420);
  });

  it('подрезка прокрутки при смене экрана (контент усох) не затирает запомненную позицию', async () => {
    const { el } = setup();
    let height = 5000;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    el.scrollTop = 420;
    el.dispatchEvent(new Event('scroll'));
    // Экран сменился: высота упала, браузер подрезал позицию и прислал scroll до очистки эффекта.
    height = 300;
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await act(async () => screen.getByText('to-b').click());
    height = 5000;
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(420);
  });

  it('усыхание контента без события scroll: при уходе позиция тоже не подрезается', async () => {
    const { el } = setup();
    let height = 5000;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    el.scrollTop = 420;
    el.dispatchEvent(new Event('scroll'));
    height = 300; // новая страница уже смонтирована, scroll ещё не пришёл
    el.scrollTop = 0;
    await act(async () => screen.getByText('to-b').click());
    height = 5000;
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(420);
  });

  it('настоящая прокрутка после усыхания контента снова запоминается', async () => {
    const { el } = setup();
    let height = 5000;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    el.scrollTop = 420;
    el.dispatchEvent(new Event('scroll'));
    height = 1000; // список отфильтрован
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    el.scrollTop = 350; // пользователь прокрутил короткий список
    el.dispatchEvent(new Event('scroll'));
    await act(async () => screen.getByText('to-b').click());
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(350);
  });

  it('пользователь начал скроллить — восстановление прекращается; по таймеру тоже', async () => {
    vi.useFakeTimers();
    try {
      const { el } = setup();
      el.scrollTop = 300;
      el.dispatchEvent(new Event('scroll'));
      await act(async () => screen.getByText('to-b').click());
      await act(async () => screen.getByText('back').click());
      el.dispatchEvent(new Event('wheel'));
      el.scrollTop = 10;
      el.dispatchEvent(new Event('scroll'));
      expect(el.scrollTop).toBe(10);
      act(() => void vi.advanceTimersByTime(RESTORE_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });
});
