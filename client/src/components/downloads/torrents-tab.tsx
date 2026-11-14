import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { setTorrentPause } from '@/lib/acquisition/actions';
import { useEngineTorrents } from '@/lib/acquisition/hooks';
import { percent } from '@/lib/acquisition/model';
import type { EngineTorrent } from '@/lib/api/acquisition';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { formatSize } from '@/lib/sources/format';

const TONES = {
  downloading: 'accent',
  error: 'danger',
  initializing: 'neutral',
  paused: 'warning',
  seeding: 'success',
} as const;

function TorrentRow({ torrent }: { torrent: EngineTorrent }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const paused = torrent.state === 'paused';
  async function toggle() {
    setPending(true);
    try {
      await setTorrentPause(torrent.info_hash, !paused, { queryClient });
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setPending(false);
    }
  }
  return (
    <li
      className="border-divider/70 dark:border-divider-dark/70 flex items-center gap-3 border-b py-3"
      data-testid={`torrent-${torrent.info_hash}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="truncate text-sm font-semibold" title={torrent.name}>
          {torrent.name}
        </p>
        <ProgressBar aria-label={torrent.name} max={Math.max(torrent.total_bytes, 1)} value={torrent.progress_bytes} />
        <p className="text-muted flex flex-wrap items-center gap-x-2 text-xs">
          <Badge tone={TONES[torrent.state]}>{t(`acq.torrent.state.${torrent.state}`)}</Badge>
          <span>
            {formatSize(torrent.progress_bytes, t)} / {formatSize(torrent.total_bytes, t)} ·{' '}
            {percent(torrent.progress_bytes, torrent.total_bytes)}%
          </span>
          {torrent.down_bps > 0 ? (
            <span>
              ↓ {formatSize(torrent.down_bps, t)}
              {t('settings.unit.perSec')}
            </span>
          ) : null}
          {torrent.up_bps > 0 ? (
            <span>
              ↑ {formatSize(torrent.up_bps, t)}
              {t('settings.unit.perSec')}
            </span>
          ) : null}
          <span>{t('count.peers', { count: torrent.peers })}</span>
        </p>
        {torrent.error ? <p className="text-danger truncate text-xs">{torrent.error}</p> : null}
      </div>
      <Button
        aria-label={`${paused ? t('acq.torrent.resume') : t('acq.torrent.pause')}: ${torrent.name}`}
        data-testid={paused ? 'torrent-resume' : 'torrent-pause'}
        onClick={() => void toggle()}
        pending={pending}
        size="sm"
        variant="secondary"
      >
        {pending ? null : paused ? (
          <Play aria-hidden className="size-3.5" />
        ) : (
          <Pause aria-hidden className="size-3.5" />
        )}
        {paused ? t('acq.torrent.resume') : t('acq.torrent.pause')}
      </Button>
    </li>
  );
}

/** Торренты в сессии движка (старый экран «Загрузки»): состояние, скорость, пауза/возобновление. Опрос раз в 2 с. */
export function TorrentsTab() {
  const t = useT();
  const query = useEngineTorrents(true);
  if (query.isPending) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (query.isError && !query.data) {
    return (
      <ErrorState body={apiErrorMessage(query.error, t)} title={t('common.loadFailed')}>
        <Button onClick={() => void query.refetch()} variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  }
  const torrents = query.data?.torrents ?? [];
  if (torrents.length === 0) return <EmptyState body={t('acq.emptyHint.torrents')} title={t('acq.empty.torrents')} />;
  return (
    <ul data-testid="torrents-list">
      {torrents.map(tr => (
        <TorrentRow key={tr.info_hash} torrent={tr} />
      ))}
    </ul>
  );
}
