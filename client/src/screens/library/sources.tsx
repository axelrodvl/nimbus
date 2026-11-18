import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { AddMagnetForm } from '@/components/sources/add-magnet-form';
import { RetryAlbumButton } from '@/components/sources/retry-album-button';
import { TorrentList } from '@/components/sources/torrent-list';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useOnline } from '@/lib/live/hooks';
import { useT } from '@/lib/i18n/provider';
import { useAlbumTorrents, useSourcesRefresh } from '@/lib/sources/hooks';
import { useAlbumTracks, useAlbumView } from '@/lib/store/hooks';
import { ItemNotFound, parseId, useEntityState } from './entity-gate';

function ListSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-2" data-testid="sources-skeleton">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton className="h-11 w-full rounded-lg" key={i} />
      ))}
    </div>
  );
}

/** Источники альбома `/album/:id/sources`: раздачи, «Свой magnet», «Повторить поиск». */
export function SourcesScreen() {
  const t = useT();
  const id = parseId(useParams().id);
  const album = useAlbumView(id ?? -1);
  const tracks = useAlbumTracks(id ?? -1);
  const state = useEntityState(album !== undefined);
  const online = useOnline();
  const active = id !== null && state !== 'missing';
  const query = useAlbumTorrents(id ?? -1, active);
  useSourcesRefresh(id ?? -1, active);

  if (id === null) return <ItemNotFound />;
  if (state === 'missing' || (state === 'ready' && !album)) return <ItemNotFound />;
  const titles = new Map(tracks.map(tr => [tr.id, tr.title]));
  return (
    <PageLayout documentTitle={t('sources.title')}>
      <Link className="text-muted mb-4 inline-flex items-center gap-1 text-sm hover:underline" to={`/album/${id}`}>
        <ArrowLeft aria-hidden className="size-4" /> {album?.title ?? t('common.back')}
      </Link>
      <h1 className="mb-6 text-3xl font-bold tracking-tight">{t('sources.title')}</h1>
      {tracks.some(tr => tr.in_library && tr.needs_confirmation) ? (
        <p
          className="text-warning-fg mb-4 inline-flex items-center gap-1 text-sm"
          data-testid="album-needs-confirmation"
        >
          <AlertTriangle aria-hidden className="size-4" /> {t('album.needsCheck')}
        </p>
      ) : null}
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <RetryAlbumButton albumId={id} />
        </div>
        <AddMagnetForm albumId={id} />
      </div>
      {query.isPending && online ? <ListSkeleton /> : null}
      {query.isPending && !online ? <ErrorState body={t('sources.offline')} /> : null}
      {query.isError ? (
        <ErrorState body={t('common.loadFailed')}>
          <Button onClick={() => void query.refetch()} variant="secondary">
            {t('common.retry')}
          </Button>
        </ErrorState>
      ) : null}
      {query.data ? <TorrentList albumId={id} torrents={query.data} trackTitles={titles} /> : null}
    </PageLayout>
  );
}
