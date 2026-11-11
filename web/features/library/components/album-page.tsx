import Link from 'next/link';
import { Cover } from '@/components/ui/cover';
import { AlbumProgress } from '@/features/library/components/album-progress';
import { AlbumTracks } from '@/features/library/components/album-tracks';
import { albumMeta, plural } from '@/features/library/components/library-cards';
import { PlayAlbumButton } from '@/features/library/components/play-album-button';
import { RemoveFromLibraryButton } from '@/features/library/components/remove-from-library-button';
import { statusSummary, StatusMiniBar } from '@/features/library/components/status-mini-bar';
import { AddToLibraryButton } from '@/features/search/components/add-to-library-button';
import { getAlbum } from '@/lib/data/library';

export async function AlbumPage({ id }: { id: string }) {
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
            {album.primary_type ?? 'Альбом'}
          </span>
          <h1 className="text-4xl font-bold tracking-tight">{album.title}</h1>
          <p className="text-muted text-sm">
            <Link href={`/artist/${artist.id}`} className="font-medium text-black hover:underline dark:text-white">
              {album.artist_name}
            </Link>
            {album.year ? ` · ${album.year}` : ''} · {album.track_count}{' '}
            {plural(album.track_count, 'трек', 'трека', 'треков')}
          </p>
          <div className="flex flex-col gap-2">
            <StatusMiniBar counts={album.status_counts} total={album.track_count} className="max-w-sm" />
            <p className="text-muted text-xs" data-testid="album-status-summary">
              {statusSummary(album.status_counts) || albumMeta(album)}
            </p>
            <AlbumProgress albumId={album.id} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PlayAlbumButton tracks={tracks} />
            {album.in_library ? (
              <RemoveFromLibraryButton
                type="album"
                id={album.id}
                title={album.title}
                redirectTo="/library?tab=albums"
              />
            ) : (
              <AddToLibraryButton type="album" mbid={album.mbid} label="Добавить весь альбом" className="gap-2" />
            )}
            {!album.in_library && inLibraryCount > 0 ? (
              <span className="text-muted text-xs">
                В библиотеке: {inLibraryCount} из {album.track_count}
              </span>
            ) : null}
          </div>
        </div>
      </header>
      <AlbumTracks tracks={tracks} albumMbid={album.mbid} />
    </>
  );
}
