import { AlertTriangle } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Cover } from '@/components/library/cover';
import { AlbumProgress } from '@/components/library/album-progress';
import { RemoveFromLibraryButton } from '@/components/library/remove-from-library-button';
import { StatusMiniBar } from '@/components/library/status-mini-bar';
import { ServerDownloadButton } from '@/components/downloads/server-download-button';
import { OfflineControl } from '@/components/offline/subject-control';
import { PageLayout } from '@/components/page-layout';
import { PlayAlbumButton, PlayableTrackRow } from '@/components/player/play-buttons';
import { useT } from '@/lib/i18n/provider';
import { useAlbumOffline } from '@/lib/offline/hooks';
import { albumMeta, statusSummary } from '@/lib/library/status';
import { useAlbumProgress, useAlbumTracks, useAlbumView } from '@/lib/store/hooks';
import { AlbumSkeleton } from './skeletons';
import { ItemNotFound, parseId, useEntityState } from './entity-gate';

/** Альбом `/album/:id`: шапка со сводкой статусов и прогрессом, треки по дискам. */
export function AlbumScreen() {
  const t = useT();
  const id = parseId(useParams().id);
  const album = useAlbumView(id ?? -1);
  const tracks = useAlbumTracks(id ?? -1);
  const progress = useAlbumProgress(id ?? -1);
  const state = useEntityState(album !== undefined);
  const offlineSummary = useAlbumOffline(id ?? -1);

  if (id === null) return <ItemNotFound />;
  if (state === 'loading') return <AlbumSkeleton />;
  if (state === 'missing' || !album) return <ItemNotFound />;

  const queueIds = tracks.map(tr => tr.id);
  const inLibraryCount = tracks.filter(tr => tr.in_library).length;
  const multiDisc = new Set(tracks.map(tr => tr.disc_no)).size > 1;
  return (
    <PageLayout documentTitle={album.title}>
      <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover
          alt={album.title}
          className="size-48 shrink-0 self-center shadow-2xl sm:self-auto"
          priority
          src={album.cover_url}
          thumb={500}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">
            {album.primary_type ?? t('album.primaryDefault')}
          </span>
          <h1 className="text-4xl font-bold tracking-tight">{album.title}</h1>
          <p className="text-muted text-sm">
            <Link className="font-medium text-black hover:underline dark:text-white" to={`/artist/${album.artist_id}`}>
              {album.artistName}
            </Link>
            {album.year ? ` · ${album.year}` : ''} · {t('count.tracks', { count: album.trackCount })}
          </p>
          <div className="flex flex-col gap-2">
            <StatusMiniBar className="max-w-sm" counts={album.statusCounts} total={album.trackCount} />
            <p className="text-muted text-xs" data-testid="album-status-summary">
              {statusSummary(album.statusCounts, t) || albumMeta(album)}
            </p>
            <AlbumProgress progress={progress} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PlayAlbumButton albumId={album.id} />
            <ServerDownloadButton albumId={album.id} title={album.title} />
            <OfflineControl
              subject={{ id: album.id, kind: 'album', title: album.title, trackIds: queueIds }}
              summary={offlineSummary}
            />
            {tracks.some(tr => tr.in_library && tr.needs_confirmation) ? (
              <span
                className="text-warning-fg inline-flex items-center gap-1 text-xs"
                data-testid="album-needs-confirmation"
              >
                <AlertTriangle aria-hidden className="size-4" /> {t('album.needsCheck')}
              </span>
            ) : null}
            <Link
              className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark focus-visible:ring-accent/40 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
              data-testid="album-sources-link"
              to={`/album/${album.id}/sources`}
            >
              {t('album.sources')}
            </Link>
            {album.in_library ? (
              <RemoveFromLibraryButton id={album.id} redirectTo="/library/albums" title={album.title} type="album" />
            ) : null}
            {!album.in_library && inLibraryCount > 0 ? (
              <span className="text-muted text-xs">
                {t('album.inLibraryCount', { count: inLibraryCount, total: album.trackCount })}
              </span>
            ) : null}
          </div>
        </div>
      </header>
      <ol className="flex flex-col gap-0.5" data-testid="album-tracks">
        {tracks.map((tr, i) => (
          <li key={tr.id}>
            {multiDisc && tr.disc_no !== tracks[i - 1]?.disc_no ? (
              <p className="text-muted px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">
                {t('album.disc', { n: tr.disc_no })}
              </p>
            ) : null}
            <PlayableTrackRow id={tr.id} index={tr.position} queueIds={queueIds} showAlbum={false} />
          </li>
        ))}
      </ol>
    </PageLayout>
  );
}
