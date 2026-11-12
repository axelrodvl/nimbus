'use client';

import { loadMoreAlbums, loadMoreArtists, loadMoreTracks } from '@/app/actions/library';
import { Spinner } from '@/components/ui/spinner';
import { ArtistCard, LibraryAlbumCard } from '@/features/library/components/library-cards';
import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import type { TrackDto } from '@/features/library/to-player-track';
import { usePagedLoader } from '@/hooks/use-paged-loader';
import { useT } from '@/providers/i18n-provider';

function MoreButton({
  hasMore,
  pending,
  error,
  onClick,
}: {
  hasMore: boolean;
  pending: boolean;
  error: string | null;
  onClick: () => void;
}) {
  const t = useT();
  if (!hasMore) return null;
  return (
    <li className="col-span-full flex list-none flex-col items-center gap-2 py-4">
      {error ? <p className="text-danger text-xs">{error}</p> : null}
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center gap-2 rounded-full border px-5 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? <Spinner className="h-4 w-4" /> : null}
        {t('load.more')}
      </button>
    </li>
  );
}

// Компоненты рендерят `<li>` и кнопку внутри списка/сетки родителя.
export function MoreAlbums({ initialCursor, statuses }: { initialCursor: string | null; statuses: string }) {
  const { items, hasMore, pending, error, loadMore } = usePagedLoader(initialCursor, cursor =>
    loadMoreAlbums(statuses, cursor),
  );
  return (
    <>
      {items.map(a => (
        <li key={a.id}>
          <LibraryAlbumCard album={a} />
        </li>
      ))}
      <MoreButton hasMore={hasMore} pending={pending} error={error} onClick={loadMore} />
    </>
  );
}

export function MoreArtists({ initialCursor, statuses }: { initialCursor: string | null; statuses: string }) {
  const { items, hasMore, pending, error, loadMore } = usePagedLoader(initialCursor, cursor =>
    loadMoreArtists(statuses, cursor),
  );
  return (
    <>
      {items.map(a => (
        <li key={a.id}>
          <ArtistCard artist={a} />
        </li>
      ))}
      <MoreButton hasMore={hasMore} pending={pending} error={error} onClick={loadMore} />
    </>
  );
}

export function MoreTracks({
  initialCursor,
  statuses,
  firstPage,
}: {
  initialCursor: string | null;
  statuses: string;
  firstPage: TrackDto[];
}) {
  const { items, hasMore, pending, error, loadMore } = usePagedLoader(initialCursor, cursor =>
    loadMoreTracks(statuses, cursor),
  );
  const queue = [...firstPage, ...items];
  return (
    <>
      {items.map(t => (
        <li key={t.id}>
          <LibraryTrackRow track={t} queue={queue} />
        </li>
      ))}
      <MoreButton hasMore={hasMore} pending={pending} error={error} onClick={loadMore} />
    </>
  );
}
