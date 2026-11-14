import { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { toast } from 'sonner';
import { registeredPaths } from '@/app-routes';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { OfflineIndicator } from '@/components/offline-indicator';
import { Sidebar } from '@/components/sidebar';
import { ScrollContainerProvider } from '@/components/ui/scroll-container';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { visibleNavItems } from '@/lib/nav/items';
import { useScrollRestoration } from '@/lib/nav/use-scroll-restoration';
import { useSyncStatus } from '@/lib/sync/hooks';
import { useHydrated, useRowCount } from '@/lib/store/hooks';

let storageWarned = false;

/** Один раз за сессию предупреждает, что IndexedDB недоступна (данные живут только до закрытия вкладки). */
function useStorageWarning() {
  const t = useT();
  useEffect(() => {
    if (storageWarned) return;
    let alive = true;
    void appData().db.ready.then(() => {
      if (!alive || storageWarned || appData().db.persistent) return;
      storageWarned = true;
      toast.warning(t('shell.storageUnavailable'), { duration: 10_000, id: 'storage' });
    });
    return () => {
      alive = false;
    };
  }, [t]);
}

function ContentSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4 px-6 py-6 sm:px-8" data-testid="content-skeleton">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/** Первая загрузка библиотеки: локальных данных ещё нет, снимок в пути. */
function LibraryLoading({ count }: { count: number }) {
  const t = useT();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="library-loading"
    >
      <Spinner className="size-6" />
      <p className="text-gray text-sm" role="status">
        {t('sync.loading', { count })}
      </p>
    </div>
  );
}

function Content() {
  const hydrated = useHydrated();
  const rows = useRowCount();
  const sync = useSyncStatus();
  if (!hydrated) return <ContentSkeleton />;
  const firstLoad = sync.lastSyncedAt === null && rows === 0 && ['idle', 'snapshot', 'delta'].includes(sync.state);
  if (firstLoad) return <LibraryLoading count={sync.progress?.received ?? 0} />;
  return <Outlet />;
}

/** Макет приложения: боковая панель (настольная), контент, место под плеер, нижняя панель вкладок (мобильная). */
export function AppShell() {
  const items = visibleNavItems(registeredPaths);
  const scroller = useRef<HTMLElement>(null);
  // Элемент нужен виртуальным спискам как значение контекста (ref к моменту их эффектов ещё не заполнен).
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  useScrollRestoration(scroller);
  useStorageWarning();
  return (
    <div className="bg-surface dark:bg-surface-dark flex h-dvh overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <Sidebar items={items} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
          ref={node => {
            scroller.current = node;
            setScrollElement(node);
          }}
        >
          <ScrollContainerProvider value={scrollElement}>
            <Content />
          </ScrollContainerProvider>
        </main>
        {/* Сюда плеер монтируется шагом 41. */}
        <div data-slot="player" />
        <MobileTabBar items={items} />
      </div>
      <OfflineIndicator />
    </div>
  );
}
