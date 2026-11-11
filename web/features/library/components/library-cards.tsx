'use client';

import Link from 'next/link';
import { Cover } from '@/components/ui/cover';
import { Skeleton } from '@/components/ui/skeleton';
import { albumMeta } from '@/features/library/album-meta';
import { StatusMiniBar } from '@/features/library/components/status-mini-bar';
import { ArtistAvatar } from '@/features/search/components/artist-avatar';
import type { Schemas } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';

type Artist = Schemas['ArtistDto'];
type Album = Schemas['AlbumDto'];

export function ArtistCard({ artist }: { artist: Artist }) {
  const t = useT();
  return (
    <Link
      href={`/artist/${artist.id}`}
      className="bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark flex flex-col items-center gap-3 rounded-lg p-4 transition-colors"
    >
      <ArtistAvatar mbid={artist.mbid} name={artist.name} className="h-28 w-28 text-3xl" />
      <div className="flex min-w-0 flex-col items-center text-center">
        <span className="line-clamp-2 text-sm font-semibold">{artist.name}</span>
        <span className="text-muted text-xs">
          {t('count.albums', { count: artist.album_count })} · {t('count.tracks', { count: artist.track_count })}
        </span>
        {artist.import ? (
          <span
            data-testid="artist-import-badge"
            className={cn('text-xs italic', artist.import.state === 'failed' ? 'text-danger' : 'text-muted')}
          >
            {artist.import.state === 'failed'
              ? t('artist.badge.failed')
              : artist.import.state === 'retrying'
                ? t('artist.badge.retrying')
                : t('artist.badge.importing')}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

export function LibraryAlbumCard({ album, priority }: { album: Album; priority?: boolean }) {
  const t = useT();
  return (
    <Link
      href={`/album/${album.id}`}
      className={cn(
        'bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark flex h-full flex-col gap-3 rounded-lg p-3 transition-colors',
        !album.in_library && 'opacity-80',
      )}
    >
      <Cover
        src={album.cover_url}
        alt={album.title}
        size="lg"
        priority={priority}
        className="aspect-square !h-auto !w-full shadow-lg"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm font-semibold">{album.title}</span>
        <span className="text-muted line-clamp-2 text-xs">{albumMeta(album)}</span>
        {!album.in_library ? <span className="text-muted text-xs italic">{t('album.onlySingles')}</span> : null}
      </div>
      <StatusMiniBar counts={album.status_counts} total={album.track_count} />
    </Link>
  );
}

export function ArtistGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-3 p-4">
          <Skeleton className="h-28 w-28 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

export function AlbumGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 p-3">
          <Skeleton className="aspect-square w-full rounded-md" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
