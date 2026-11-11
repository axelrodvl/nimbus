import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { EmptyLibrary } from '@/features/library/components/empty-library';
import { ArtistCard, LibraryAlbumCard } from '@/features/library/components/library-cards';
import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import { MoreAlbums, MoreArtists, MoreTracks } from '@/features/library/components/load-more';
import { getLibraryAlbums, getLibraryArtists, getLibraryTracks } from '@/lib/data/library';
import { cn } from '@/lib/utils';

export const TABS = [
  { id: 'artists', label: 'Артисты' },
  { id: 'albums', label: 'Альбомы' },
  { id: 'tracks', label: 'Треки' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

export const STATUS_FILTERS = [
  { id: 'all', label: 'Все', statuses: '' },
  { id: 'playable', label: 'Готовы к прослушиванию', statuses: 'found,ready' },
  { id: 'adding', label: 'Ищем', statuses: 'adding' },
  { id: 'not_found', label: 'Не найдены', statuses: 'not_found' },
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

export function LibraryTabs({ active }: { active: TabId }) {
  return (
    <nav aria-label="Разделы библиотеки" className="mb-6 flex gap-2">
      {TABS.map(t => (
        <Link
          key={t.id}
          href={`/library?tab=${t.id}`}
          aria-current={t.id === active ? 'page' : undefined}
          className={cn(pill, t.id === active ? pillActive : pillIdle)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function StatusChips({ active }: { active: StatusFilterId }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Фильтр по статусу">
      {STATUS_FILTERS.map(s => (
        <Link
          key={s.id}
          href={`/library?tab=tracks&status=${s.id}`}
          aria-current={s.id === active ? 'true' : undefined}
          className={cn(pill, 'text-xs', s.id === active ? pillActive : pillIdle)}
        >
          {s.label}
        </Link>
      ))}
    </div>
  );
}

export async function LibraryContent({ tab, status }: { tab: TabId; status: StatusFilterId }) {
  return (
    <>
      <LibraryTabs active={tab} />
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
  const statuses = STATUS_FILTERS.find(s => s.id === status)!.statuses;
  const page = await getLibraryTracks(statuses);
  return (
    <>
      <StatusChips active={status} />
      {page.items.length === 0 ? (
        status === 'all' ? (
          <EmptyLibrary />
        ) : (
          <EmptyState title="Нет треков с таким статусом" />
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
