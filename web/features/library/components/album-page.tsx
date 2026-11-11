import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { Cover } from '@/components/ui/cover';
import { albumMeta } from '@/features/library/album-meta';
import { AlbumProgress } from '@/features/library/components/album-progress';
import { AlbumTracks } from '@/features/library/components/album-tracks';
import { PlayAlbumButton } from '@/features/library/components/play-album-button';
import { RemoveFromLibraryButton } from '@/features/library/components/remove-from-library-button';
import { StatusMiniBar } from '@/features/library/components/status-mini-bar';
import { statusSummary } from '@/features/library/status-summary';
import { AddToLibraryButton } from '@/features/search/components/add-to-library-button';
import { getAlbum } from '@/lib/data/library';
import { getT } from '@/lib/i18n/server';

export async function AlbumPage({ id }: { id: string }) {
  const t = await getT();
  const { album, artist, tracks } = await getAlbum(id);
  const inLibraryCount = tracks.filter(t => t.in_library).length;
  return (
    <>
      <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover
          src={album.cover_url}
          alt={album.title}
          size="lg"
          priority
          className="!h-48 !w-48 shrink-0 self-center shadow-2xl sm:self-auto"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">
            {album.primary_type ?? t('album.primaryDefault')}
          </span>
          <h1 className="text-4xl font-bold tracking-tight">{album.title}</h1>
          <p className="text-muted text-sm">
            <Link href={`/artist/${artist.id}`} className="font-medium text-black hover:underline dark:text-white">
              {album.artist_name}
            </Link>
            {album.year ? ` · ${album.year}` : ''} · {t('count.tracks', { count: album.track_count })}
          </p>
          <div className="flex flex-col gap-2">
            <StatusMiniBar counts={album.status_counts} total={album.track_count} className="max-w-sm" />
            <p className="text-muted text-xs" data-testid="album-status-summary">
              {statusSummary(album.status_counts, t) || albumMeta(album)}
            </p>
            <AlbumProgress albumId={album.id} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PlayAlbumButton tracks={tracks} />
            <Link
              href={`/album/${album.id}/sources`}
              className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
            >
              {t('album.sources')}
            </Link>
            {tracks.some(t => t.in_library && t.needs_confirmation) ? (
              <span
                className="text-warning inline-flex items-center gap-1 text-xs"
                data-testid="album-needs-confirmation"
              >
                <AlertTriangle className="h-4 w-4" aria-hidden /> {t('album.needsCheck')}
              </span>
            ) : null}
            {album.in_library ? (
              <RemoveFromLibraryButton
                type="album"
                id={album.id}
                title={album.title}
                redirectTo="/library?tab=albums"
              />
            ) : (
              <AddToLibraryButton type="album" mbid={album.mbid} label={t('album.addAll')} className="gap-2" />
            )}
            {!album.in_library && inLibraryCount > 0 ? (
              <span className="text-muted text-xs">
                {t('album.inLibraryCount', { count: inLibraryCount, total: album.track_count })}
              </span>
            ) : null}
          </div>
        </div>
      </header>
      <AlbumTracks tracks={tracks} albumMbid={album.mbid} />
    </>
  );
}
