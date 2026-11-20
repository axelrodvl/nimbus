import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { AlbumCard, ALBUM_CARD_EXTRA } from '@/components/library/album-card';
import { ARTIST_CARD_HEIGHT, ArtistCard } from '@/components/library/artist-card';
import { PlayAlbumButton, PlayableTrackRow } from '@/components/player/play-buttons';
import { PendingStrip, usePending } from '@/components/library/pending-add';
import { TRACK_ROW_HEIGHT } from '@/components/library/track-row';
import { PlaylistsTab } from '@/components/playlists/playlists-tab';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs } from '@/components/ui/tabs';
import { VirtualGrid, useGridColumns } from '@/components/ui/virtual-grid';
import { VirtualList } from '@/components/ui/virtual-list';
import { useT } from '@/lib/i18n/provider';
import { useDownloadedSets, useOfflineSupported } from '@/lib/offline/hooks';
import type { DownloadedSets } from '@/lib/offline/derive';
import {
  LIBRARY_TABS,
  STATUS_FILTERS,
  libraryHref,
  parseStatusFilter,
  parseTab,
  type LibraryTabId,
  type StatusFilterId,
} from '@/lib/library/tabs';
import { useFilteredLibraryList } from '@/lib/library/use-filtered-list';
import { SEARCH_ENTRY } from '@/lib/nav/items';
import { useHydrated, useLibraryCounts, useTracksHydrated } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { LibrarySkeleton } from './skeletons';

const pill =
  'rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none';
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

type ListProps = { q: string; status: StatusFilterId; downloaded: DownloadedSets | null };

function AlbumsList({ q, status, downloaded }: ListProps) {
  const { all, items } = useFilteredLibraryList('albums', { downloaded, q, status });
  const columns = useGridColumns(5);
  if (items.length === 0)
    return <Empty downloaded={downloaded !== null} hasData={all.length > 0} kind="album" status={status} />;
  return (
    <VirtualGrid
      columns={columns}
      count={items.length}
      data-testid="library-albums"
      getKey={i => items[i]?.id ?? i}
      renderCell={i =>
        items[i] ? (
          <AlbumCard
            actions={<PlayAlbumButton albumId={items[i].id} variant="icon" />}
            album={items[i]}
            priority={i < 4}
          />
        ) : null
      }
      rowHeight={w => w + ALBUM_CARD_EXTRA}
    />
  );
}

function ArtistsList({ q, status, downloaded }: ListProps) {
  const { all, items } = useFilteredLibraryList('artists', { downloaded, q, status });
  const columns = useGridColumns(5);
  if (items.length === 0)
    return <Empty downloaded={downloaded !== null} hasData={all.length > 0} kind="artist" status={status} />;
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

function TracksList({ q, status, downloaded }: ListProps) {
  const { all, items } = useFilteredLibraryList('tracks', { downloaded, q, status });
  const queueIds = items.map(tr => tr.id);
  if (items.length === 0)
    return <Empty downloaded={downloaded !== null} hasData={all.length > 0} kind="track" status={status} />;
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
function Empty({
  hasData,
  status,
  downloaded,
  kind,
}: {
  hasData: boolean;
  status: StatusFilterId;
  downloaded: boolean;
  kind: PendingKind;
}) {
  const t = useT();
  // Пустой список, но в него уже что-то добавляется — призыв к поиску неуместен, заглушки над списком.
  const adding = usePending(kind).length > 0;
  if (!hasData && status === 'all' && !downloaded && adding) return null;
  if (downloaded && hasData) return <EmptyState title={t('offline.library.none')} />;
  if (!hasData && status === 'all') return <EmptyLibrary />;
  return <EmptyState title={hasData ? t('search.none') : t('library.noTracksStatus')} />;
}

const PENDING_TYPE = { albums: 'album', artists: 'artist', tracks: 'track' } as const;
type PendingKind = (typeof PENDING_TYPE)[keyof typeof PENDING_TYPE];

const LISTS: Record<LibraryTabId, (props: ListProps) => React.ReactNode> = {
  albums: AlbumsList,
  artists: ArtistsList,
  playlists: ({ q }) => <PlaylistsTab q={q} />,
  tracks: TracksList,
};

/** Библиотека `/library/:tab?`: вкладки со счётчиками, фильтр по статусу и подстроке; состояние — в URL. */
export function LibraryScreen() {
  const t = useT();
  const hydrated = useHydrated();
  const tracksReady = useTracksHydrated();
  const counts = useLibraryCounts();
  const tab = parseTab(useParams().tab);
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  // Поле держит собственное значение: беря его из URL (обновляется переходом роутера), быстрый набор терял бы символы.
  const [q, setQ] = useState(urlQuery);
  // Внешняя смена `?q=` (назад/вперёд, ссылка с `q`) переносится в поле; набор текста URL уже совпадает с полем.
  const [prevUrl, setPrevUrl] = useState(urlQuery);
  if (urlQuery !== prevUrl) {
    setPrevUrl(urlQuery);
    if (urlQuery !== q) setQ(urlQuery);
  }
  const status = parseStatusFilter(params.get('status'));
  const supported = useOfflineSupported();
  const onlyDownloaded = supported && params.get('offline') === '1';
  const downloaded = useDownloadedSets(onlyDownloaded && tab !== 'playlists');
  // Альбомы и артисты без фильтров рисуются сразу после фазы 1; остальное строится из треков (фаза 2).
  const needsTracks = tab === 'tracks' || tab === 'playlists' || status !== 'all' || onlyDownloaded;
  if (!hydrated || (needsTracks && !tracksReady)) {
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
        <Tabs
          aria-label={t('library.tabs')}
          items={LIBRARY_TABS.map(item => ({
            'data-testid': `tab-${item.id}`,
            id: item.id,
            label: (
              <>
                {t(item.label)} {/* До фазы 2 числа неполны: место под них занято, чтобы вкладки не прыгали. */}
                <span className="inline-block min-w-[2ch] tabular-nums">{tracksReady ? counts[item.id] : ''}</span>
              </>
            ),
            to: libraryHref(item.id, { offline: onlyDownloaded, q, status }),
          }))}
          selectedId={tab}
        />
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">{t('library.search.label')}</span>
          <Search
            aria-hidden
            className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <input
            className="border-divider dark:border-divider-dark focus-visible:ring-accent/40 w-full rounded-full border bg-white py-1.5 pr-3 pl-9 text-sm focus-visible:ring-2 focus-visible:outline-none dark:bg-black"
            onChange={e => {
              setQ(e.target.value);
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
      {tab === 'playlists' ? null : (
        <div aria-label={t('library.filter')} className="mb-4 flex flex-wrap gap-2" role="group">
          {STATUS_FILTERS.map(s => (
            <Link
              aria-current={s.id === status ? 'true' : undefined}
              className={cn(pill, 'text-xs', s.id === status ? pillActive : pillIdle)}
              key={s.id}
              to={libraryHref(tab, { offline: onlyDownloaded, q, status: s.id })}
            >
              {t(s.label)}
            </Link>
          ))}
          {supported ? (
            <Link
              aria-current={onlyDownloaded ? 'true' : undefined}
              className={cn(pill, 'text-xs', onlyDownloaded ? pillActive : pillIdle)}
              data-testid="filter-downloaded"
              to={libraryHref(tab, { offline: !onlyDownloaded, q, status })}
            >
              {t('offline.library.filter')}
            </Link>
          ) : null}
        </div>
      )}
      {tab !== 'playlists' && !q && status === 'all' && !onlyDownloaded ? (
        <PendingStrip type={PENDING_TYPE[tab]} />
      ) : null}
      <List downloaded={downloaded} q={q} status={status} />
    </PageLayout>
  );
}
