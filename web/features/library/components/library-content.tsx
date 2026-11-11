import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { EmptyLibrary } from '@/features/library/components/empty-library';
import { ArtistCard, LibraryAlbumCard } from '@/features/library/components/library-cards';
import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import { MoreAlbums, MoreArtists, MoreTracks } from '@/features/library/components/load-more';
import { getLibraryAlbums, getLibraryArtists, getLibraryTracks } from '@/lib/data/library';
import { getT, type TFn } from '@/lib/i18n/server';
import { cn } from '@/lib/utils';

export const TABS = [
  { id: 'artists', label: 'group.artists' },
  { id: 'albums', label: 'group.albums' },
  { id: 'tracks', label: 'group.tracks' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

export const STATUS_FILTERS = [
  { id: 'all', label: 'filter.all', statuses: '' },
  { id: 'playable', label: 'filter.playable', statuses: 'found,ready' },
  { id: 'adding', label: 'filter.adding', statuses: 'adding' },
  { id: 'not_found', label: 'filter.notFound', statuses: 'not_found' },
] as const;
export type StatusFilterId = (typeof STATUS_FILTERS)[number]['id'];

export function parseTab(value: string | string[] | undefined): TabId {
  return TABS.find(t => t.id === value)?.id ?? 'albums';
}

export function parseStatusFilter(value: string | string[] | undefined): StatusFilterId {
  return STATUS_FILTERS.find(s => s.id === value)?.id ?? 'all';
}

const pill = 'rounded-full px-4 py-1.5 text-sm font-medium transition-colors';
const pillActive = 'bg-black text-white dark:bg-white dark:text-black';
const pillIdle = 'bg-card text-muted hover:text-black dark:bg-card-dark dark:hover:text-white';

export function LibraryTabs({ active, t }: { active: TabId; t: TFn }) {
  return (
    <nav aria-label={t('library.tabs')} className="mb-6 flex gap-2">
      {TABS.map(tab => (
        <Link
          key={tab.id}
          href={`/library?tab=${tab.id}`}
          aria-current={tab.id === active ? 'page' : undefined}
          className={cn(pill, tab.id === active ? pillActive : pillIdle)}
        >
          {t(tab.label)}
        </Link>
      ))}
    </nav>
  );
}

function StatusChips({ active, t }: { active: StatusFilterId; t: TFn }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('library.filter')}>
      {STATUS_FILTERS.map(s => (
        <Link
          key={s.id}
          href={`/library?tab=tracks&status=${s.id}`}
          aria-current={s.id === active ? 'true' : undefined}
          className={cn(pill, 'text-xs', s.id === active ? pillActive : pillIdle)}
        >
          {t(s.label)}
        </Link>
      ))}
    </div>
  );
}

export async function LibraryContent({ tab, status }: { tab: TabId; status: StatusFilterId }) {
  const t = await getT();
  return (
    <>
      <LibraryTabs active={tab} t={t} />
      {tab === 'artists' ? <ArtistsTab /> : tab === 'albums' ? <AlbumsTab /> : <TracksTab status={status} />}
    </>
  );
}

async function ArtistsTab() {
  const page = await getLibraryArtists();
  if (page.items.length === 0) return <EmptyLibrary />;
  return (
    <ul data-testid="library-artists" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {page.items.map(a => (
        <li key={a.id}>
          <ArtistCard artist={a} />
        </li>
      ))}
      <MoreArtists key={page.next_cursor ?? 'end'} initialCursor={page.next_cursor ?? null} />
    </ul>
  );
}

async function AlbumsTab() {
  const page = await getLibraryAlbums();
  if (page.items.length === 0) return <EmptyLibrary />;
  return (
    <ul data-testid="library-albums" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {page.items.map((a, i) => (
        <li key={a.id}>
          <LibraryAlbumCard album={a} priority={i < 4} />
        </li>
      ))}
      <MoreAlbums key={page.next_cursor ?? 'end'} initialCursor={page.next_cursor ?? null} />
    </ul>
  );
}

async function TracksTab({ status }: { status: StatusFilterId }) {
  const t = await getT();
  const statuses = STATUS_FILTERS.find(s => s.id === status)!.statuses;
  const page = await getLibraryTracks(statuses);
  return (
    <>
      <StatusChips active={status} t={t} />
      {page.items.length === 0 ? (
        status === 'all' ? (
          <EmptyLibrary />
        ) : (
          <EmptyState title={t('library.noTracksStatus')} />
        )
      ) : (
        <ul data-testid="library-tracks" className="flex flex-col gap-0.5">
          {page.items.map(t => (
            <li key={t.id}>
              <LibraryTrackRow track={t} queue={page.items} />
            </li>
          ))}
          <MoreTracks
            key={page.next_cursor ?? 'end'}
            initialCursor={page.next_cursor ?? null}
            statuses={statuses}
            firstPage={page.items}
          />
        </ul>
      )}
    </>
  );
}
