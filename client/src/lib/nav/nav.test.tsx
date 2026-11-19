import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNavLink } from '@/components/app-nav-link';
import { renderRoutes } from '@/test/render';
import { hasRoute, NAV_ITEMS, visibleNavItems } from './items';
import {
  MAX_POSITIONS,
  POSITIONS_KEY,
  type Position,
  RESTORE_TIMEOUT_MS,
  resetScrollPositions,
  restoreScrollOnce,
  SCROLL_X_ATTR,
  useScrollRestoration,
} from './use-scroll-restoration';
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
  beforeEach(() => {
    resetScrollPositions();
    sessionStorage.clear();
  });
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
        <button onClick={() => void navigate(1)} type="button">
          forward
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
            { element: <p {...{ [SCROLL_X_ATTR]: 'row' }}>a</p>, path: '/' },
            { element: <p>b</p>, path: '/b' },
          ],
          element: <Layout />,
        },
      ],
      { initialEntries: ['/'] },
    );
    const view = render(<RouterProvider router={router} />);
    const el = screen.getByTestId('scroller');
    // happy-dom не считает раскладку: scrollTop принимает любое значение.
    return { el, router, view };
  }
  // Жизненный цикл сводит повторные уходы в фон в один — сначала «вернуться».
  const hide = () => {
    globalThis.dispatchEvent(new Event('pageshow'));
    globalThis.dispatchEvent(new Event('pagehide'));
  };
  const stored = () => JSON.parse(sessionStorage.getItem(POSITIONS_KEY) ?? '[]') as [string, Position][];
  const scroll = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  };

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

  it('экран, помнящий прокрутку, задаёт позицию следующего перехода вперёд — один раз', async () => {
    const { el, router } = setup();
    restoreScrollOnce(300);
    await act(async () => screen.getByText('to-b').click());
    expect(el.scrollTop).toBe(300);
    await act(async () => void router.navigate('/'));
    expect(el.scrollTop).toBe(0);
    restoreScrollOnce(0);
    await act(async () => screen.getByText('to-b').click());
    expect(el.scrollTop).toBe(0);
  });

  it('подрезка прокрутки под новый короткий экран достаётся новому экрану, а не прежнему', async () => {
    const { el } = setup();
    scroll(el, 420);
    await act(async () => screen.getByText('to-b').click());
    // Браузер подрезал позицию под короткий экран «b» уже после смены: событие получает слушатель нового экрана.
    scroll(el, 0);
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(420);
  });

  it('усыхание контента без события scroll: при уходе позиция тоже не подрезается', async () => {
    const { el } = setup();
    scroll(el, 420);
    el.scrollTop = 0; // новая страница уже смонтирована, scroll ещё не пришёл
    await act(async () => screen.getByText('to-b').click());
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(420);
  });

  it('прокрутка после того, как экран сам стал ниже (ушёл skeleton), запоминается — «вперёд» её возвращает', async () => {
    const { el } = setup();
    let height = 5000;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    await act(async () => screen.getByText('to-b').click());
    height = 800; // экран дорисовался и стал короче — без события scroll
    scroll(el, 163);
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(0);
    await act(async () => screen.getByText('forward').click());
    expect(el.scrollTop).toBe(163);
  });

  it('настоящая прокрутка после усыхания контента снова запоминается', async () => {
    const { el } = setup();
    scroll(el, 420);
    scroll(el, 200); // список отфильтрован, позиция подрезана
    scroll(el, 350); // пользователь прокрутил короткий список
    await act(async () => screen.getByText('to-b').click());
    await act(async () => screen.getByText('back').click());
    expect(el.scrollTop).toBe(350);
  });

  it('горизонтальная прокрутка ряда карточек тоже возвращается «назад»', async () => {
    const { el } = setup();
    const row = () => el.querySelector<HTMLElement>(`[${SCROLL_X_ATTR}="row"]`)!;
    row().scrollLeft = 240;
    row().dispatchEvent(new Event('scroll'));
    await act(async () => screen.getByText('to-b').click());
    await act(async () => screen.getByText('back').click());
    expect(row()).not.toBeNull();
    expect(row().scrollLeft).toBe(240);
  });

  it('позиции уходят в sessionStorage при скрытии страницы и возвращаются после перезагрузки', async () => {
    const { el, view } = setup();
    await act(async () => screen.getByText('to-b').click());
    scroll(el, 420);
    hide();
    expect(stored().map(([, p]) => p.top)).toContain(420);
    view.unmount();

    // Перезагрузка: ключ записи истории тот же (react-router хранит его в `history.state`), память — новая.
    // Ряда `gone` на экране нет — его позиция просто ждёт.
    sessionStorage.setItem(POSITIONS_KEY, JSON.stringify([['entry-1', { top: 777, x: { gone: 50, row: 30 } }]]));
    resetScrollPositions(true);
    const router = createMemoryRouter(
      [{ children: [{ element: <p {...{ [SCROLL_X_ATTR]: 'row' }}>a</p>, path: '/' }], element: <Layout /> }],
      { initialEntries: [{ key: 'entry-1', pathname: '/' }] },
    );
    render(<RouterProvider router={router} />);
    const restored = screen.getAllByTestId('scroller').at(-1)!;
    expect(restored.scrollTop).toBe(777);
    expect(restored.querySelector<HTMLElement>(`[${SCROLL_X_ATTR}="row"]`)!.scrollLeft).toBe(30);
  });

  it('приложение ушло в фон — позиции сохраняются (iOS может выгрузить его без pagehide)', async () => {
    const { el } = setup();
    await act(async () => screen.getByText('to-b').click());
    scroll(el, 321);
    globalThis.dispatchEvent(new Event('pageshow'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(sessionStorage.getItem(POSITIONS_KEY)).toContain('321');
  });

  it('помнит не больше MAX_POSITIONS записей — старые вытесняются', async () => {
    const old = Array.from({ length: MAX_POSITIONS + 20 }, (_, i) => [`k${i}`, { top: i + 1, x: {} }]);
    sessionStorage.setItem(POSITIONS_KEY, JSON.stringify(old));
    resetScrollPositions(true);
    setup();
    await act(async () => screen.getByText('to-b').click());
    hide();
    const saved = stored();
    // В памяти — ровно MAX_POSITIONS, одна из них — первая запись (`default`), её в хранилище нет.
    expect(saved).toHaveLength(MAX_POSITIONS - 1);
    expect(saved.map(([k]) => k)).not.toContain('k0');
    expect(saved.map(([k]) => k)).toContain(`k${MAX_POSITIONS + 19}`);
  });

  it('первая запись вкладки (ключ `default`) в хранилище не идёт: после загрузки другой страницы он тот же', async () => {
    const { el } = setup();
    scroll(el, 420);
    hide();
    expect(stored().map(([k]) => k)).not.toContain('default');
    // Чужая запись с этим ключом (старый формат, другая вкладка) при чтении отбрасывается.
    sessionStorage.setItem(POSITIONS_KEY, JSON.stringify([['default', { top: 999, x: {} }]]));
    resetScrollPositions(true);
    cleanup();
    expect(setup().el.scrollTop).toBe(0);
    // В памяти позиция первой записи работает как обычно.
    scroll(screen.getByTestId('scroller'), 150);
    await act(async () => screen.getByText('to-b').click());
    await act(async () => screen.getByText('back').click());
    expect(screen.getByTestId('scroller').scrollTop).toBe(150);
  });

  it('замена записи (REPLACE, набор запроса в поиске) не копит мёртвые позиции', async () => {
    const { el, router } = setup();
    await act(async () => screen.getByText('to-b').click());
    for (let i = 0; i < 5; i++) await act(async () => void router.navigate(`/b?q=${i}`, { replace: true }));
    scroll(el, 40);
    hide();
    // Первая запись (`default`) не сохраняется, от замен осталась одна — текущая.
    expect(stored()).toHaveLength(1);
    expect(stored()[0]![1].top).toBe(40);
  });

  it('из хранилища берутся только осмысленные числа', () => {
    sessionStorage.setItem(
      POSITIONS_KEY,
      JSON.stringify([
        ['a', { top: 10, x: { bad: '50', neg: -1, ok: 20 } }],
        ['b', { top: 'x' }],
        ['c', { top: 5, x: 'abc' }],
        'junk',
        [1, { top: 1 }],
      ]),
    );
    resetScrollPositions(true);
    hide();
    expect(stored()).toEqual([
      ['a', { top: 10, x: { ok: 20 } }],
      ['c', { top: 5, x: {} }],
    ]);
    sessionStorage.setItem(POSITIONS_KEY, JSON.stringify({ not: 'array' }));
    resetScrollPositions(true);
    hide();
    expect(stored()).toEqual([]);
  });

  it('повреждённая запись в sessionStorage не ломает восстановление', () => {
    sessionStorage.setItem(POSITIONS_KEY, '{not json');
    resetScrollPositions(true);
    const { el } = setup();
    expect(el.scrollTop).toBe(0);
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
