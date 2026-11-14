import { Search } from 'lucide-react';
import { useDeferredValue } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { AlbumCard, ALBUM_CARD_EXTRA } from '@/components/library/album-card';
import { ARTIST_CARD_HEIGHT, ArtistCard } from '@/components/library/artist-card';
import { PlayAlbumButton, PlayableTrackRow } from '@/components/player/play-buttons';
import { TRACK_ROW_HEIGHT } from '@/components/library/track-row';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { VirtualGrid, useGridColumns } from '@/components/ui/virtual-grid';
import { VirtualList } from '@/components/ui/virtual-list';
import { useT } from '@/lib/i18n/provider';
import {
  LIBRARY_TABS,
  STATUS_FILTERS,
  libraryHref,
  parseStatusFilter,
  parseTab,
  type LibraryTabId,
  type StatusFilterId,
} from '@/lib/library/tabs';
import { SEARCH_ENTRY } from '@/lib/nav/items';
import { useHydrated, useLibraryCounts, useLibraryList } from '@/lib/store/hooks';
import { filterByName } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';
import { LibrarySkeleton } from './skeletons';

const pill = 'rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none';
const pillActive = 'bg-black text-white dark:bg-white dark:text-black';
const pillIdle = 'bg-card text-muted hover:text-black dark:bg-card-dark dark:hover:text-white';

function EmptyLibrary() {
  const t = useT();
  return (
    <EmptyState body={t('library.empty.body')} title={t('library.empty.title')}>
      <Link to={SEARCH_ENTRY}>
        <Button variant="secondary">{t('library.empty.cta')}</Button>
      </Link>
    </EmptyState>
  );
}

function AlbumsList({ q, status }: { q: string; status: StatusFilterId }) {
  const statuses = STATUS_FILTERS.find(s => s.id === status)?.statuses;
  const all = useLibraryList('albums', statuses);
  const items = filterByName(all, useDeferredValue(q), a => a.title);
  const columns = useGridColumns(5);
  if (items.length === 0) return <Empty hasData={all.length > 0} status={status} />;
  return (
    <VirtualGrid
      columns={columns}
      count={items.length}
      data-testid="library-albums"
      getKey={i => items[i]?.id ?? i}
      renderCell={i => (items[i] ? (
          <AlbumCard actions={<PlayAlbumButton albumId={items[i].id} variant="icon" />} album={items[i]} priority={i < 4} />
        ) : null)}
      rowHeight={w => w + ALBUM_CARD_EXTRA}
    />
  );
}

function ArtistsList({ q, status }: { q: string; status: StatusFilterId }) {
  const statuses = STATUS_FILTERS.find(s => s.id === status)?.statuses;
  const all = useLibraryList('artists', statuses);
  const items = filterByName(all, useDeferredValue(q), a => a.name);
  const columns = useGridColumns(5);
  if (items.length === 0) return <Empty hasData={all.length > 0} status={status} />;
  return (
    <VirtualGrid
      columns={columns}
      count={items.length}
      data-testid="library-artists"
      getKey={i => items[i]?.id ?? i}
      renderCell={i => (items[i] ? <ArtistCard artist={items[i]} /> : null)}
      rowHeight={() => ARTIST_CARD_HEIGHT}
    />
  );
}

function TracksList({ q, status }: { q: string; status: StatusFilterId }) {
  const statuses = STATUS_FILTERS.find(s => s.id === status)?.statuses;
  const all = useLibraryList('tracks', statuses);
  const items = filterByName(all, useDeferredValue(q), tr => tr.title);
  const queueIds = items.map(tr => tr.id);
  if (items.length === 0) return <Empty hasData={all.length > 0} status={status} />;
  return (
    <VirtualList
      count={items.length}
      data-testid="library-tracks"
      getKey={i => items[i]?.id ?? i}
      renderRow={i => (items[i] ? <PlayableTrackRow id={items[i].id} queueIds={queueIds} /> : null)}
      rowHeight={TRACK_ROW_HEIGHT}
    />
  );
}

/** Пусто: библиотека без фильтров — призыв к поиску; иначе — «ничего не подходит». */
function Empty({ hasData, status }: { hasData: boolean; status: StatusFilterId }) {
  const t = useT();
  if (!hasData && status === 'all') return <EmptyLibrary />;
  return <EmptyState title={hasData ? t('search.none') : t('library.noTracksStatus')} />;
}

const LISTS: Record<LibraryTabId, typeof AlbumsList> = { albums: AlbumsList, artists: ArtistsList, tracks: TracksList };

/** Библиотека `/library/:tab?`: вкладки со счётчиками, фильтр по статусу и подстроке; состояние — в URL. */
export function LibraryScreen() {
  const t = useT();
  const hydrated = useHydrated();
  const counts = useLibraryCounts();
  const tab = parseTab(useParams().tab);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = parseStatusFilter(params.get('status'));
  if (!hydrated) {
    return (
      <PageLayout title={t('nav.library')}>
        <LibrarySkeleton />
      </PageLayout>
    );
  }
  const List = LISTS[tab];
  return (
    <PageLayout title={t('nav.library')}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t('library.tabs')} className="flex gap-2">
          {LIBRARY_TABS.map(item => (
            <Link
              aria-current={item.id === tab ? 'page' : undefined}
              className={cn(pill, item.id === tab ? pillActive : pillIdle)}
              data-testid={`tab-${item.id}`}
              key={item.id}
              to={libraryHref(item.id, { q, status })}
            >
              {t(item.label)} <span className="tabular-nums opacity-70">{counts[item.id]}</span>
            </Link>
          ))}
        </nav>
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">{t('library.search.label')}</span>
          <Search aria-hidden className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <input
            className="border-divider dark:border-divider-dark focus-visible:ring-accent/40 w-full rounded-full border bg-white py-1.5 pr-3 pl-9 text-sm focus-visible:ring-2 focus-visible:outline-none dark:bg-black"
            onChange={e => {
              const next = new URLSearchParams(params);
              if (e.target.value) next.set('q', e.target.value);
              else next.delete('q');
              // Каждое нажатие не должно добавлять запись в историю.
              setParams(next, { replace: true });
            }}
            placeholder={t('library.search.placeholder')}
            type="search"
            value={q}
          />
        </label>
      </div>
      <div aria-label={t('library.filter')} className="mb-4 flex flex-wrap gap-2" role="group">
        {STATUS_FILTERS.map(s => (
          <Link
            aria-current={s.id === status ? 'true' : undefined}
            className={cn(pill, 'text-xs', s.id === status ? pillActive : pillIdle)}
            key={s.id}
            to={libraryHref(tab, { q, status: s.id })}
          >
            {t(s.label)}
          </Link>
        ))}
      </div>
      <List q={q} status={status} />
    </PageLayout>
  );
}
