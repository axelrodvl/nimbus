import { ArtistImportStatus } from '@/features/library/components/artist-import-status';
import { LibraryAlbumCard } from '@/features/library/components/library-cards';
import { RemoveFromLibraryButton } from '@/features/library/components/remove-from-library-button';
import { ArtistAvatar } from '@/features/search/components/artist-avatar';
import { getArtist } from '@/lib/data/library';
import { getT } from '@/lib/i18n/server';

export async function ArtistPage({ id }: { id: string }) {
  const t = await getT();
  const { artist, albums } = await getArtist(id);
  return (
    <>
      <header className="mb-8 flex flex-col items-center gap-6 sm:flex-row">
        <ArtistAvatar mbid={artist.mbid} name={artist.name} className="h-40 w-40 text-5xl" />
        <div className="flex min-w-0 flex-col items-center gap-3 sm:items-start">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">{t('kind.artist')}</span>
          <h1 className="text-4xl font-bold tracking-tight">{artist.name}</h1>
          {artist.disambiguation ? <p className="text-muted text-sm">{artist.disambiguation}</p> : null}
          <p className="text-muted text-sm" data-testid="artist-counts">
            {t('artist.counts', {
              albums: t('count.albums', { count: artist.album_count }),
              tracks: t('count.tracks', { count: artist.track_count }),
            })}
          </p>
          {artist.import ? <ArtistImportStatus artistId={artist.id} status={artist.import} /> : null}
          {artist.in_library ? (
            <RemoveFromLibraryButton
              type="artist"
              id={artist.id}
              title={artist.name}
              redirectTo="/library?tab=artists"
            />
          ) : null}
        </div>
      </header>
      <h2 className="mb-4">{t('artist.albums')}</h2>
      {albums.length === 0 ? (
        <p className="text-muted text-sm">
          {artist.import ? null : t('artist.noAlbums')}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {albums.map((a, i) => (
            <li key={a.id}>
              <LibraryAlbumCard album={a} priority={i < 4} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
