import { QueryClient } from '@tanstack/react-query';

/** Общий QueryClient приложения: им пользуются и компоненты (через провайдер), и loader-ы маршрутов. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});
