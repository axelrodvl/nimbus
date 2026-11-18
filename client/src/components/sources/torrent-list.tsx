import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { apiErrorMessage } from '@/lib/api/error-message';
import type { AlbumTorrent } from '@/lib/api/sources';
import { useT } from '@/lib/i18n/provider';
import { selectAlbumTorrent } from '@/lib/sources/actions';
import { formatSize, kindLabel, metaLabel, sourceLabel } from '@/lib/sources/format';
import { useTorrentFiles } from '@/lib/sources/hooks';
import { cn } from '@/lib/utils';

/** Колонки на широком экране; на узком каждая раздача — карточка из двух строк. */
const GRID =
  'md:grid md:grid-cols-[1.25rem_5rem_minmax(0,1fr)_5rem_5rem_5rem_4.5rem_9rem_5rem] md:items-center md:gap-3';

/**
 * Раздачи альбома: таблица (название, источник, формат, тип, размер, сиды/личи, статус метаданных, совпало треков и
 * оценка); на мобильной ширине — карточки. Раздача, из которой играют треки альбома, помечена «Используется». Строка
 * раскрывается: файлы с сопоставленными треками и кнопка «Использовать для альбома».
 */
export function TorrentList({
  albumId,
  torrents,
  trackTitles,
}: {
  albumId: number;
  torrents: AlbumTorrent[];
  /** Названия треков альбома по id (для пометок у файлов). */
  trackTitles: ReadonlyMap<number, string>;
}) {
  const t = useT();
  if (torrents.length === 0) {
    return (
      <p className="text-muted text-sm" data-testid="no-torrents">
        {t('sources.none')}
      </p>
    );
  }
  return (
    <div>
      <div aria-hidden className={cn(GRID, 'text-muted hidden px-3 pb-1 text-xs font-medium tracking-wide uppercase')}>
        <span />
        <span>{t('sources.sourceTitle')}</span>
        <span>{t('sources.colTitle')}</span>
        <span>{t('sources.colFormat')}</span>
        <span>{t('sources.colKind')}</span>
        <span>{t('sources.colSize')}</span>
        <span>{t('sources.seedsLeeches')}</span>
        <span>{t('sources.colStatus')}</span>
        <span>{t('sources.colScore')}</span>
      </div>
      <ul className="flex flex-col gap-2" data-testid="torrent-list">
        {torrents.map(item => (
          <TorrentItem albumId={albumId} item={item} key={item.torrent.id} trackTitles={trackTitles} />
        ))}
      </ul>
    </div>
  );
}

function TorrentItem({
  albumId,
  item,
  trackTitles,
}: {
  albumId: number;
  item: AlbumTorrent;
  trackTitles: ReadonlyMap<number, string>;
}) {
  const t = useT();
  const { torrent: tor } = item;
  const inUse = item.primary_tracks > 0;
  const [open, setOpen] = useState(false);
  const files = useTorrentFiles(tor.id, open);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li
      className={cn(
        'rounded-lg border',
        inUse ? 'border-accent/60' : 'border-divider dark:border-divider-dark',
      )}
      data-in-use={inUse}
      data-testid="torrent-item"
    >
      <button
        aria-expanded={open}
        className={cn(
          GRID,
          'hover:bg-card/60 dark:hover:bg-card-dark/60 focus-visible:ring-accent/40 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none',
        )}
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <Chevron aria-hidden className="size-4 shrink-0" />
        <span
          className="bg-card dark:bg-card-dark w-fit rounded px-2 py-0.5 text-xs font-medium"
          title={t('sources.sourceTitle')}
        >
          {sourceLabel(tor.source, t)}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 md:flex-none">
          <span className="min-w-0 truncate text-sm font-medium">{tor.title}</span>
          {inUse ? (
            <Badge
              className="shrink-0"
              data-testid="torrent-in-use"
              tone="accent"
            >
              <span title={t('sources.inUseTitle', { count: item.primary_tracks })}>{t('sources.inUse')}</span>
            </Badge>
          ) : null}
        </span>
        <span className="font-mono text-xs font-medium" data-testid="torrent-formats" title={t('sources.colFormat')}>
          {item.formats.length > 0 ? item.formats.join(' · ') : '—'}
        </span>
        <span className="text-muted text-xs">{kindLabel(tor.kind, t)}</span>
        <span className="text-muted font-mono text-xs">{formatSize(tor.size_bytes, t)}</span>
        <span className="text-muted font-mono text-xs" title={t('sources.seedsLeeches')}>
          {tor.seeders ?? '?'}/{tor.leechers ?? '?'}
        </span>
        <span className="text-muted text-xs" data-testid="torrent-meta" data-status={tor.meta_status}>
          {metaLabel(tor.meta_status, t)}
        </span>
        <span
          className="flex items-center gap-1 text-xs whitespace-nowrap"
          title={`${t('sources.matchedTracks')} · ${t('sources.colScore')} ${item.rank_score.toFixed(2)}`}
        >
          {item.verified ? (
            <ShieldCheck aria-label={t('sources.verified')} className="text-success-fg size-3.5" role="img" />
          ) : null}
          {t('sources.matchedShort', { count: item.matched_tracks })}
        </span>
      </button>
      {open ? (
        <div className="border-divider dark:border-divider-dark border-t px-3 py-2">
          <UseTorrent albumId={albumId} item={item} />
          {files.isPending ? <Spinner className="size-4" /> : null}
          {files.isError ? (
            <div className="flex items-center gap-3 text-xs" role="alert">
              <span className="text-danger-fg">{t('common.loadFailed')}</span>
              <Button onClick={() => void files.refetch()} size="sm" variant="secondary">
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
          {files.data?.length === 0 ? <p className="text-muted text-xs">{t('sources.filesUnknown')}</p> : null}
          <ul className="flex flex-col gap-0.5">
            {files.data?.map(f => (
              <li className="flex items-center gap-3 text-xs" data-testid="torrent-file" key={f.file_index}>
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="text-muted font-mono">{formatSize(f.size_bytes, t)}</span>
                {f.matched_track_id != null ? (
                  <span className="text-accent-fg truncate">
                    {trackTitles.get(f.matched_track_id) ?? t('sources.trackFallback', { id: f.matched_track_id })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

/** «Использовать для альбома»: подтверждение (скачанные копии удалятся) → перевод альбома на раздачу. */
function UseTorrent({ albumId, item }: { albumId: number; item: AlbumTorrent }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = Ariakit.useDialogStore();
  if (item.torrent.meta_status !== 'ok') {
    return <p className="text-muted mb-2 text-xs">{t('sources.useNeedsMeta')}</p>;
  }
  async function run(): Promise<boolean> {
    try {
      const r = await selectAlbumTorrent(albumId, item.torrent.id, { queryClient });
      toast.success(
        r.switched_track_ids.length === 0
          ? t('sources.useUnchanged')
          : r.image_downloading
            ? t('sources.useDoneImage', { count: r.switched_track_ids.length })
            : t('sources.useDone', { count: r.switched_track_ids.length }),
      );
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    }
  }
  return (
    <div className="mb-2">
      <Button data-testid="use-torrent" onClick={confirm.show} size="sm">
        {t('sources.use')}
      </Button>
      <ConfirmDialog
        confirmAction={run}
        confirmLabel={t('sources.use')}
        description={t('sources.useConfirmBody')}
        store={confirm}
        title={t('sources.useConfirmTitle')}
        variant="primary"
      />
    </div>
  );
}
