import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { CrashScreen } from '@/components/crash-screen';
import { IosViewportHeal } from '@/components/ios-viewport-heal';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { I18nProvider } from '@/lib/i18n/provider';
import { queryClient } from '@/lib/query/client';
import { router } from './router';

export function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary fallback={<CrashScreen />}>
          <RouterProvider router={router} />
        </ErrorBoundary>
        <IosViewportHeal />
        <Toaster
          // Уведомления под вырезом/«островом» iPhone: отступ сверху считается от безопасной области.
          mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}
          offset={{ top: 'calc(env(safe-area-inset-top) + 16px)' }}
          position="top-center"
        />
      </QueryClientProvider>
    </I18nProvider>
  );
}
