import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { TrackDialogsProvider } from '@/components/library/track-dialogs';
import { I18nProvider } from '@/lib/i18n/provider';
import { createI18nStore } from '@/lib/i18n/store';
import ru from '@/lib/i18n/messages/ru';

type Options = { route?: string; path?: string };

export const testQueryClient = () =>
  new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });

const providers = (router: ReturnType<typeof createMemoryRouter>, queryClient = testQueryClient()) => {
  const store = createI18nStore({ locale: 'ru', messages: ru });
  return (
    <I18nProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <TrackDialogsProvider>
          <RouterProvider router={router} />
        </TrackDialogsProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
};

/** Рендер с провайдерами приложения: router в памяти, i18n `ru`, QueryClient без повторов. */
export function renderWithProviders(ui: ReactElement, { route = '/', path = '*' }: Options = {}): RenderResult {
  const router = createMemoryRouter([{ element: ui, path }], { initialEntries: [route] });
  return render(providers(router));
}

/**
 * Рендер целой таблицы маршрутов; роутер возвращается для навигации в тесте. `queryClient` — свой, если loader-ам
 * маршрутов нужен тот же кэш, что и экранам.
 */
export function renderRoutes(routes: RouteObject[], route = '/', queryClient?: QueryClient) {
  const router = createMemoryRouter(routes, { initialEntries: [route] });
  return { router, ...render(providers(router, queryClient)) };
}
