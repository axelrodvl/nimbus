import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { CrashScreen } from '@/components/crash-screen';
import { IosViewportHeal } from '@/components/ios-viewport-heal';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { I18nProvider } from '@/lib/i18n/provider';
import { router } from './router';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

export function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary fallback={<CrashScreen />}>
          <RouterProvider router={router} />
        </ErrorBoundary>
        <IosViewportHeal />
        <Toaster position="top-center" />
      </QueryClientProvider>
    </I18nProvider>
  );
}
