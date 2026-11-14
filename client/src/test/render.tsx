import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { I18nProvider } from '@/lib/i18n/provider';
import { createI18nStore } from '@/lib/i18n/store';
import ru from '@/lib/i18n/messages/ru';

type Options = { route?: string; path?: string };

/** Рендер с провайдерами приложения: router в памяти, i18n `ru`, QueryClient без повторов. */
export function renderWithProviders(ui: ReactElement, { route = '/', path = '*' }: Options = {}): RenderResult {
  const store = createI18nStore({ locale: 'ru', messages: ru });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const router = createMemoryRouter([{ element: ui, path }], { initialEntries: [route] });
  return render(
    <I18nProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
