import { useEffect, useMemo, useRef, useState } from 'react';
import { AlbumRow, ROW_HEIGHT } from '@/components/downloads/album-row';
import { BulkRetryBar } from '@/components/downloads/bulk-retry-bar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { VirtualList } from '@/components/ui/virtual-list';
import { useAcquisitionList, useEngineTorrents } from '@/lib/acquisition/hooks';
import { useNow } from '@/lib/acquisition/use-now';
import { TAB_STATES, tabFilter, type AlbumTab } from '@/lib/acquisition/model';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';

/** Пока в отфильтрованном списке меньше строк, чем влезает на экран, следующие страницы догружаются сами. */
const MIN_ROWS = 8;

function ListSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3" data-testid="acq-skeleton">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton className="h-24 w-full rounded-xl" key={i} />
      ))}
    </div>
  );
}

/** Вкладка со списком альбомов: страницы по курсору, виртуализация, догрузка при прокрутке. */
export function AlbumTabView({ tab }: { tab: AlbumTab }) {
  const t = useT();
  const online = useOnline();
  const query = useAcquisitionList(TAB_STATES[tab]);
  const engine = useEngineTorrents(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const rows = useMemo(() => query.items.filter(tabFilter(tab)), [query.items, tab]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // Выбор не переживает смену вкладки и исчезнувшие строки: пересечение с текущим списком.
  const chosen = useMemo(
    () => new Set(rows.filter(r => selected.has(r.album.id)).map(r => r.album.id)),
    [rows, selected],
  );
  const now = useNow();

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !query.isError && rows.length < MIN_ROWS) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, query.isError, rows.length, fetchNextPage]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !hasNextPage) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, rows.length]);

  if (query.isPending) {
    return online ? (
      <ListSkeleton />
    ) : (
      <ErrorState body={t('acq.offline')} title={t('common.loadFailed')}>
        <Button onClick={() => void query.refetch()} variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  }
  if (query.isError && rows.length === 0) {
    return (
      <ErrorState body={apiErrorMessage(query.error, t)} title={t('common.loadFailed')}>
        <Button onClick={() => void query.refetch()} variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  }
  const paused = engine.data?.paused ?? false;
  return (
    <div data-testid={`acq-tab-${tab}`}>
      {tab === 'attention' ? (
        <BulkRetryBar
          onRetried={() => setSelected(new Set())}
          onSelectAll={on => setSelected(on ? new Set(rows.map(r => r.album.id)) : new Set())}
          rows={rows}
          selected={chosen}
        />
      ) : null}
      {rows.length === 0 && !hasNextPage ? (
        <EmptyState body={t(`acq.emptyHint.${tab}`)} title={t(`acq.empty.${tab}`)} />
      ) : (
        <VirtualList
          aria-label={t(`acq.tab.${tab}`)}
          count={rows.length}
          data-testid="acq-list"
          getKey={i => rows[i]?.album.id ?? i}
          renderRow={i => {
            const item = rows[i];
            if (!item) return null;
            return (
              <AlbumRow
                item={item}
                onSelect={
                  tab === 'attention'
                    ? on =>
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (on) next.add(item.album.id);
                          else next.delete(item.album.id);
                          return next;
                        })
                    : undefined
                }
                paused={paused}
                now={now}
                selected={chosen.has(item.album.id)}
                tab={tab}
              />
            );
          }}
          rowHeight={ROW_HEIGHT}
        />
      )}
      {hasNextPage ? (
        <div className="flex justify-center py-4" ref={sentinel}>
          <Button
            data-testid="acq-more"
            onClick={() => void fetchNextPage()}
            pending={isFetchingNextPage}
            variant="secondary"
          >
            {t('acq.more')}
          </Button>
        </div>
      ) : null}
      {query.isError ? (
        <p className="text-danger py-2 text-sm" role="alert">
          {apiErrorMessage(query.error, t)}
        </p>
      ) : null}
    </div>
  );
}
