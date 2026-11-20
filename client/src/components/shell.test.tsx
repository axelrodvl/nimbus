import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '@/app-routes';
import { appData, resetAppData } from '@/lib/app-data';
import { ApiError } from '@/lib/api/errors';
import { session, SESSION_TIMEOUT_MS, SPLASH_HINT_MS } from '@/lib/auth';
import { describeSync } from '@/lib/sync/describe';
import { makeLibrary, resetFactories } from '@/test/factories';
import { renderRoutes } from '@/test/render';
import { NotFound } from '@/screens/not-found';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { ConnectionIndicator } from './connection-indicator';
import { CrashScreen } from './crash-screen';
import { OfflineIndicator } from './offline-indicator';
import { LoginRoute, RequireSession } from './session-routes';
import { SyncStatus } from './sync-status';

// Сетевой слой сессии подменён: тест «висящего» запроса управляет ответом сам; по умолчанию — «нет сети».
const authApi = vi.hoisted(() => ({
  login: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  session: vi.fn<(signal?: AbortSignal) => Promise<{ auth_required: boolean; authenticated: boolean }>>(),
}));
vi.mock('@/lib/api/auth', () => ({ createAuthApi: () => authApi }));

const routes = [
  { element: <LoginRoute />, path: '/login' },
  { children: [...appRoutes, { element: <NotFound />, path: '*' }], element: <RequireSession /> },
];

const setSession = (s: Partial<ReturnType<typeof session.store.getState>>) =>
  session.store.setState({ authRequired: true, loggedOut: false, status: 'unknown', unreachable: false, ...s });

beforeEach(() => {
  resetFactories();
  setSession({});
});
afterEach(async () => {
  await resetAppData(true);
});

describe('защита маршрутов', () => {
  it('сессия ещё неизвестна → заставка; недоступный сервер без кэша → кнопка «Повторить»', () => {
    renderRoutes(routes, '/');
    expect(screen.getByTestId('splash')).toBeInTheDocument();
    act(() => setSession({ unreachable: true }));
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('висящий /api/auth/session: через 3 с подпись у заставки, после таймаута — «Повторить»', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    authApi.session.mockImplementationOnce(
      s =>
        new Promise<never>((_, reject) => {
          signal = s;
          s?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    try {
      renderRoutes(routes, '/');
      const started = session.start();
      expect(screen.getByTestId('splash')).toBeInTheDocument();
      expect(screen.queryByText('Подключение к серверу…')).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(SPLASH_HINT_MS));
      expect(screen.getByText('Подключение к серверу…')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS - SPLASH_HINT_MS));
      await act(() => started);
      expect(signal?.aborted).toBe(true);
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('anonymous при включённой авторизации → /login?next=<путь>; корень — без next', async () => {
    setSession({ status: 'anonymous' });
    const { router } = renderRoutes(routes, '/search?q=a');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?next=%2Fsearch%3Fq%3Da');
    expect(screen.getByLabelText('Токен доступа')).toBeInTheDocument();

    const root = renderRoutes(routes, '/');
    await waitFor(() => expect(root.router.state.location.search).toBe(''));
  });

  it('после выхода /login открывается без next', async () => {
    setSession({ loggedOut: true, status: 'anonymous' });
    const { router } = renderRoutes(routes, '/library');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('');
  });

  it('authenticated на /login → на next; внешний next игнорируется', async () => {
    setSession({ status: 'authenticated' });
    appData().library.getState().hydrate(makeLibrary());
    const a = renderRoutes(routes, '/login?next=%2Fmissing');
    await waitFor(() => expect(a.router.state.location.pathname).toBe('/missing'));
    expect(screen.getByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    const b = renderRoutes(routes, '/login?next=%2F%2Fevil.example');
    await waitFor(() => expect(b.router.state.location.pathname).toBe('/'));
  });

  it('авторизация выключена: anonymous не требует входа; /login ведёт в приложение', async () => {
    setSession({ authRequired: false, status: 'anonymous' });
    renderRoutes(routes, '/');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    const { router } = renderRoutes(routes, '/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('потеря входа посреди работы убирает оболочку и ведёт на /login?next=…', async () => {
    setSession({ status: 'authenticated' });
    const { router } = renderRoutes(routes, '/missing');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    act(() => setSession({ status: 'anonymous' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?next=%2Fmissing');
  });

  it('на /login неизвестная сессия — заставка', () => {
    renderRoutes(routes, '/login');
    expect(screen.getByTestId('splash')).toBeInTheDocument();
  });
});

describe('экран входа', () => {
  beforeEach(() => setSession({ status: 'anonymous' }));

  it('пустое поле → «Введите токен», запрос не уходит', async () => {
    const login = vi.spyOn(session, 'login').mockResolvedValue();
    renderRoutes(routes, '/login');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Введите токен');
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError(401, 'unauthorized', 'x'), 'Неверный токен'],
    [new ApiError(0, 'network', 'x'), 'Бэкенд недоступен, попробуйте позже'],
    [new ApiError(500, 'internal', 'x'), 'Не удалось войти, попробуйте позже'],
  ])('ошибка %#: показывается текст, кнопка снова доступна', async (error, text) => {
    vi.spyOn(session, 'login').mockRejectedValue(error);
    renderRoutes(routes, '/login');
    await userEvent.type(screen.getByLabelText('Токен доступа'), ' tok ');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled();
  });

  it('кнопка заблокирована на время запроса; токен обрезается; успех ведёт на next', async () => {
    let finish = () => {};
    const login = vi.spyOn(session, 'login').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = () => {
            setSession({ status: 'authenticated' });
            resolve();
          };
        }),
    );
    const { router } = renderRoutes(routes, '/login?next=%2Fmissing');
    await userEvent.type(screen.getByLabelText('Токен доступа'), ' tok ');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(login).toHaveBeenCalledWith('tok');
    expect(screen.getByRole('button', { name: 'Войти' })).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(router.state.location.pathname).toBe('/missing'));
  });
});

describe('оболочка', () => {
  beforeEach(() => setSession({ status: 'authenticated' }));

  it('до чтения базы — skeleton, затем контент; есть место под плеер и обе панели навигации', async () => {
    const { container } = renderRoutes(routes, '/');
    expect(screen.getByTestId('content-skeleton')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="player"]')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    act(() => appData().library.getState().hydrate(makeLibrary()));
    expect(screen.queryByTestId('content-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nimbus' })).toBeInTheDocument();
    // Пункты есть у зарегистрированных маршрутов: «Поиск» и «Загрузки» (шаг 44).
    expect(screen.getAllByRole('link', { name: 'Главная' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Поиск' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Загрузки' }).length).toBeGreaterThan(0);
  });

  it('база пуста и снимок в пути → экран загрузки с прогрессом; после синхронизации — контент', () => {
    renderRoutes(routes, '/');
    act(() =>
      appData().library.getState().hydrate({ albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] }),
    );
    act(() => appData().engine.status.setState({ progress: { received: 4000 }, state: 'snapshot' }));
    expect(screen.getByTestId('library-loading')).toHaveTextContent('Загружаем библиотеку… 4000');
    act(() => appData().engine.status.setState({ lastSyncedAt: 1, progress: null, state: 'live' }));
    expect(screen.queryByTestId('library-loading')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nimbus' })).toBeInTheDocument();
  });

  it('офлайн без данных не блокирует интерфейс экраном загрузки', () => {
    renderRoutes(routes, '/');
    act(() =>
      appData().library.getState().hydrate({ albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] }),
    );
    act(() => appData().engine.status.setState({ state: 'offline' }));
    expect(screen.queryByTestId('library-loading')).not.toBeInTheDocument();
  });

  it('выход из боковой панели вызывает session.logout', async () => {
    const logout = vi.spyOn(session, 'logout').mockResolvedValue();
    renderRoutes(routes, '/');
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(logout).toHaveBeenCalled();
  });

  it('недоступная IndexedDB: предупреждение показывается один раз за сессию', async () => {
    const warning = vi.spyOn(toast, 'warning').mockReturnValue('x');
    const app = appData();
    Object.defineProperty(app.db, 'persistent', { value: false });
    renderRoutes(routes, '/');
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    renderRoutes(routes, '/');
    await act(async () => app.db.ready);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('индикаторы', () => {
  it('describeSync: каждое состояние движка — свой текст, тон и кнопка повтора', () => {
    expect(describeSync({ progress: { received: 7 }, state: 'snapshot' })).toEqual({
      count: 7,
      label: 'sync.loading',
      retry: false,
      tone: 'busy',
    });
    expect(describeSync({ progress: null, state: 'snapshot' }).count).toBe(0);
    expect(describeSync({ progress: null, state: 'delta' }).label).toBe('sync.syncing');
    expect(describeSync({ progress: null, state: 'hydrating' }).label).toBe('sync.syncing');
    expect(describeSync({ progress: null, state: 'live' })).toMatchObject({ label: 'sync.live', tone: 'ok' });
    expect(describeSync({ progress: null, state: 'idle' }).label).toBe('sync.live');
    expect(describeSync({ progress: null, state: 'offline' })).toMatchObject({ label: 'sync.offline', retry: true });
    expect(describeSync({ progress: null, state: 'error' })).toMatchObject({ label: 'sync.error', retry: true });
  });

  it('SyncStatus показывает текст состояния; «Повторить» запрашивает синхронизацию', async () => {
    const request = vi.spyOn(appData().engine, 'requestSync');
    renderRoutes([{ element: <SyncStatus />, path: '*' }]);
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Библиотека синхронизирована');
    act(() => appData().engine.status.setState({ state: 'delta' }));
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Синхронизация…');
    act(() => appData().engine.status.setState({ state: 'offline' }));
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Нет связи');
    act(() => appData().engine.status.setState({ state: 'error' }));
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Не удалось синхронизировать');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(request).toHaveBeenCalledWith('manual');
  });

  it('SyncStatus: подпись можно скрыть классом, точка сохраняет aria-label', () => {
    renderRoutes([{ element: <SyncStatus labelClassName="hidden" />, path: '*' }]);
    expect(screen.getByRole('status', { name: 'Библиотека синхронизирована' })).toBeInTheDocument();
    expect(screen.getByText('Библиотека синхронизирована')).toHaveClass('hidden');
  });

  it('ConnectionIndicator: closed / connecting / open', () => {
    renderRoutes([{ element: <ConnectionIndicator showLabel />, path: '*' }]);
    const state = (s: 'closed' | 'connecting' | 'open') => act(() => appData().socket.state.setState({ state: s }));
    state('closed');
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Нет соединения с бэкендом');
    expect(screen.getByText('Офлайн')).toBeInTheDocument();
    state('connecting');
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Подключение к бэкенду…');
    state('open');
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Соединение с бэкендом установлено');
    expect(screen.getByText('Онлайн')).toBeInTheDocument();
  });

  it('ConnectionIndicator: подпись можно скрыть классом (узкая боковая панель показывает одну точку)', () => {
    renderRoutes([{ element: <ConnectionIndicator labelClassName="hidden lg:inline" showLabel />, path: '*' }]);
    act(() => appData().socket.state.setState({ state: 'closed' }));
    expect(screen.getByText('Офлайн')).toHaveClass('hidden', 'lg:inline');
  });

  it('OfflineIndicator: toast при закрытом сокете и при navigator.onLine=false; снимается при восстановлении', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('offline');
    const dismiss = vi.spyOn(toast, 'dismiss');
    renderRoutes([{ element: <OfflineIndicator />, path: '*' }]);
    act(() => appData().socket.state.setState({ state: 'open' }));
    expect(error).not.toHaveBeenCalled();
    act(() => appData().socket.state.setState({ state: 'closed' }));
    expect(error).toHaveBeenCalledTimes(1);
    act(() => appData().socket.state.setState({ state: 'open' }));
    expect(dismiss).toHaveBeenCalledWith('offline');

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('ошибки и язык', () => {
  it('ErrorBoundary с экраном сбоя: «Перезагрузить» и «Сбросить локальные данные» (база стирается)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const clear = vi.spyOn(appData().db, 'clear');
    function Boom(): never {
      throw new Error('boom');
    }
    renderRoutes([
      {
        element: (
          <ErrorBoundary fallback={<CrashScreen />}>
            <Boom />
          </ErrorBoundary>
        ),
        path: '*',
      },
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('Что-то пошло не так');
    await userEvent.click(screen.getByRole('button', { name: 'Перезагрузить' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить локальные данные' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(clear).toHaveBeenCalled();
  });

  it('errorElement маршрута показывает экран сбоя', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { RouteError } = await import('./route-error');
    function Boom(): never {
      throw new Error('boom');
    }
    renderRoutes([{ element: <Boom />, errorElement: <RouteError />, path: '*' }]);
    expect(screen.getByRole('button', { name: 'Перезагрузить' })).toBeInTheDocument();
  });

  it('страница 404 внутри оболочки ведёт на главную', async () => {
    setSession({ status: 'authenticated' });
    appData().library.getState().hydrate(makeLibrary());
    const { router } = renderRoutes(routes, '/nope');
    expect(screen.getByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'На главную' }));
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('ленивые маршруты', () => {
  it('экраны отдельного чанка (поиск, каталог MusicBrainz, источники) грузятся одним чанком и отдают свой компонент', async () => {
    const lazy = Object.fromEntries(
      appRoutes
        .filter(r => typeof r.lazy === 'function')
        .map(r => [r.path, r.lazy as () => Promise<{ Component: unknown }>]),
    );
    const rare = await import('@/screens/rare-screens');
    expect((await lazy['/album/:id/sources']!()).Component).toBe(rare.SourcesScreen);
    expect((await lazy['/search/artist/:mbid']!()).Component).toBe(rare.CatalogArtistScreen);
    expect((await lazy['/search/album/:mbid']!()).Component).toBe(rare.CatalogAlbumScreen);
    expect((await lazy['/search']!()).Component).toBe(rare.SearchScreen);
  });
});

describe('предзагрузка экранов отдельного чанка', () => {
  it('чанк поиска и каталога грузится в простое после старта', async () => {
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const { usePreloadRareScreens } = await import('./app-shell');
    function Probe() {
      usePreloadRareScreens();
      return null;
    }
    const { unmount } = renderRoutes([{ element: <Probe />, path: '*' }]);
    expect(idle).toHaveBeenCalledOnce();
    unmount();
  });

  it('без requestIdleCallback — по таймеру', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { usePreloadRareScreens } = await import('./app-shell');
    function Probe() {
      usePreloadRareScreens();
      return null;
    }
    const { unmount } = renderRoutes([{ element: <Probe />, path: '*' }]);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 500);
    unmount();
  });
});
