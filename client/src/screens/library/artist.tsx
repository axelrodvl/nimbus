import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { AlbumCard } from '@/components/library/album-card';
import { ArtistAvatar } from '@/components/library/artist-avatar';
import { ArtistImportStatus } from '@/components/library/artist-import-status';
import { RemoveFromLibraryButton } from '@/components/library/remove-from-library-button';
import { PageLayout } from '@/components/page-layout';
import { PlayAlbumButton, PlayTracksButton } from '@/components/player/play-buttons';
import { ApiError } from '@/lib/api/errors';
import { retryArtistImport } from '@/lib/api/library';
import { useT } from '@/lib/i18n/provider';
import { artistImportKey, shouldCheckImport, useArtistImport } from '@/lib/library/use-artist-import';
import { useArtistAlbums, useArtistTracks, useArtistView } from '@/lib/store/hooks';
import type { AlbumView } from '@/lib/store/selectors';
import { ArtistSkeleton, AlbumGridSkeleton } from './skeletons';
import { ItemNotFound, parseId, useEntityState } from './entity-gate';

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

const GROUPS = [
  { id: 'album', label: 'artist.albums' },
  { id: 'ep', label: 'artist.group.ep' },
  { id: 'single', label: 'artist.group.single' },
  { id: 'other', label: 'artist.group.other' },
] as const;
type GroupId = (typeof GROUPS)[number]['id'];

const groupOf = (a: AlbumView): GroupId => {
  const type = a.primary_type?.toLowerCase();
  return type === 'album' || type === 'ep' || type === 'single' ? type : 'other';
};

/** Альбомы по группам типа релиза; внутри группы порядок селектора (по году выхода). Пустые группы не показываются. */
export function groupAlbums(albums: AlbumView[]): { id: GroupId; label: (typeof GROUPS)[number]['label']; albums: AlbumView[] }[] {
  return GROUPS.map(g => ({ ...g, albums: albums.filter(a => groupOf(a) === g.id) })).filter(g => g.albums.length > 0);
}

/** Артист `/artist/:id`: шапка, альбомы по группам, статус импорта (единственные данные не из store). */
export function ArtistScreen() {
  const t = useT();
  const id = parseId(useParams().id);
  const artist = useArtistView(id ?? -1);
  // Только то, что в библиотеке (альбом или хоть один его трек): альбомы, которые лишь открывали в поиске или
  // слушали, лежат в БД, но в библиотеку не входят.
  const albums = useArtistAlbums(id ?? -1, true);
  const artistTracks = useArtistTracks(id ?? -1);
  const queryClient = useQueryClient();
  const state = useEntityState(artist !== undefined);
  const { data: importStatus } = useArtistImport(id ?? -1, artist !== undefined && shouldCheckImport(artist));

  if (id === null) return <ItemNotFound />;
  if (state === 'loading') return <ArtistSkeleton />;
  if (state === 'missing' || !artist) return <ItemNotFound />;

  const artistId = artist.id;
  async function retry() {
    try {
      await retryArtistImport(artistId);
      toast.success(t('artist.import.restarted'));
      await queryClient.invalidateQueries({ queryKey: artistImportKey(artistId) });
    } catch (e) {
      toast.error(e instanceof ApiError && e.code !== 'unknown' ? e.message : t('common.loadFailed'));
    }
  }

  const groups = groupAlbums(albums);
  return (
    <PageLayout documentTitle={artist.name}>
      <header className="mb-8 flex flex-col items-center gap-6 sm:flex-row">
        <ArtistAvatar className="h-40 w-40 text-5xl" mbid={artist.mbid} name={artist.name} />
        <div className="flex w-full min-w-0 max-w-full flex-col items-center gap-3 sm:w-auto sm:items-start">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">{t('kind.artist')}</span>
          <h1 className="text-4xl font-bold tracking-tight">{artist.name}</h1>
          {artist.disambiguation ? <p className="text-muted text-sm">{artist.disambiguation}</p> : null}
          <p className="text-muted text-sm" data-testid="artist-counts">
            {t('artist.counts', {
              albums: t('count.albums', { count: artist.albumCount }),
              tracks: t('count.tracks', { count: artist.trackCount }),
            })}
          </p>
          {importStatus ? <ArtistImportStatus onRetry={retry} status={importStatus} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <PlayTracksButton testId="play-artist" tracks={artistTracks} />
            {artist.in_library ? (
              <RemoveFromLibraryButton id={artist.id} redirectTo="/library/artists" title={artist.name} type="artist" />
            ) : null}
          </div>
        </div>
      </header>
      {groups.length === 0 ? (
        <>
          <h2 className="mb-4">{t('artist.albums')}</h2>
          {importStatus ? <AlbumGridSkeleton count={5} /> : <p className="text-muted text-sm">{t('artist.noAlbums')}</p>}
        </>
      ) : (
        groups.map((g, gi) => (
          <section aria-labelledby={`artist-group-${g.id}`} className="mb-8" data-testid={`artist-group-${g.id}`} key={g.id}>
            <h2 className="mb-4" id={`artist-group-${g.id}`}>
              {t(g.label)}
            </h2>
            <ul className={GRID}>
              {g.albums.map((a, i) => (
                <li key={a.id}>
                  <AlbumCard actions={<PlayAlbumButton albumId={a.id} variant="icon" />} album={a} priority={gi === 0 && i < 4} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </PageLayout>
  );
}
