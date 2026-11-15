import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ActionMenu, type MenuAction } from '@/components/downloads/action-menu';
import { Cover } from '@/components/library/cover';
import { AddMagnetForm } from '@/components/sources/add-magnet-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { ProgressBar } from '@/components/ui/progress-bar';
import { pinAlbum, retryAlbums, unpinAlbum } from '@/lib/acquisition/actions';
import { nextRetryText, percent, pinStateText, reasonText, type AlbumTab } from '@/lib/acquisition/model';
import type { AcquisitionItem } from '@/lib/api/acquisition';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { sourceLabel, formatSize } from '@/lib/sources/format';
import { useAlbumProgress, useDownloadProgress } from '@/lib/store/hooks';

/** Высота строки вместе с зазором: строки одинаковые, поэтому список виртуализируется без измерений. */
export const ROW_HEIGHT = 112;

/** Основная кнопка строки: на узком экране — квадратная иконка (подпись остаётся для скринридеров). */
const ROW_BUTTON = 'max-sm:size-9 max-sm:p-0';

type Props = {
  item: AcquisitionItem;
  tab: AlbumTab;
  /** Загрузки на паузе (`GET /api/downloads`). */
  paused: boolean;
  /** Текущее время (для «следующий повтор через …»). */
  now: number;
  /** Выбор строки (только вкладка «Требуют внимания»). */
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
};

function ProviderErrors({ item }: { item: AcquisitionItem }) {
  const t = useT();
  const store = Ariakit.useDialogStore();
  const errors = item.search.provider_errors;
  if (errors.length === 0) return null;
  return (
    <>
      <button
        className="text-warning-fg focus-visible:ring-accent/40 rounded text-xs underline focus-visible:ring-2 focus-visible:outline-none"
        data-testid="provider-errors"
        onClick={store.show}
        type="button"
      >
        {t('acq.providerErrors', { count: errors.length })}
      </button>
      <Dialog store={store} title={t('acq.providerErrorsTitle')}>
        <ul className="flex flex-col gap-2 text-sm" data-testid="provider-errors-list">
          {errors.map((e, i) => (
            <li key={`${e.source}-${i}`}>
              <span className="font-medium">{sourceLabel(e.source, t)}</span>
              <span className="text-muted block break-words">{e.error}</span>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

/** Строка альбома экрана «Загрузки»: содержимое и действия зависят от вкладки. */
export function AlbumRow({ item, tab, paused, now, selected, onSelect }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const ctx = { queryClient };
  const live = useDownloadProgress(item.album.id);
  const jobProgress = useAlbumProgress(item.album.id);
  const magnet = Ariakit.useDialogStore();
  const confirmDelete = Ariakit.useDialogStore();
  const [pending, setPending] = useState(false);
  const { album, tracks, search, download } = item;
  const reason = reasonText(item.reason, t);

  async function run(action: () => Promise<unknown>, success?: string) {
    setPending(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setPending(false);
    }
  }

  const retry = () =>
    run(async () => {
      const queued = await retryAlbums([album.id], { resetDead: false }, ctx);
      toast.success(t('acq.queued', { count: queued }));
    });
  const download_ = () => run(() => pinAlbum(album.id, ctx));
  const cancel = () => run(() => unpinAlbum(album.id, { deleteFiles: false }, ctx));

  const done = live?.bytes_done ?? download?.bytes_done ?? 0;
  const total = live?.bytes_total ?? download?.bytes_total ?? 0;
  const speed = live?.down_bps ?? download?.down_bps ?? 0;
  const peers = live?.peers ?? download?.peers ?? 0;

  let primary: React.ReactNode = null;
  const menu: MenuAction[] = [];
  let details: React.ReactNode = null;

  if (tab === 'attention') {
    primary = (
      <Button
        className={ROW_BUTTON}
        data-testid="row-retry"
        onClick={() => void retry()}
        pending={pending}
        size="sm"
        variant="secondary"
      >
        {pending ? null : <RefreshCw aria-hidden className="size-3.5" />}
        <span className="max-sm:sr-only">{t('sources.retry')}</span>
      </Button>
    );
    menu.push(
      { id: 'sources', label: t('album.sources'), to: `/album/${album.id}/sources` },
      { id: 'magnet', label: t('sources.addMagnet'), onClick: magnet.show },
    );
    const next = nextRetryText(search.next_retry_at, now, t);
    details = (
      <>
        <p className="text-muted truncate text-xs">
          {t('acq.found', { found: tracks.found + tracks.ready, total: tracks.total })}
          {search.attempts > 0 ? ` · ${t('acq.attempts', { count: search.attempts })}` : ''}
          {next ? ` · ${next}` : ''}
        </p>
        {reason ? (
          <p className="truncate text-xs" data-testid="row-reason">
            <span className="text-warning-fg font-medium">{reason.reason}</span>
            <span className="text-muted hidden sm:inline"> — {reason.hint}</span>
          </p>
        ) : null}
        <ProviderErrors item={item} />
      </>
    );
  } else if (tab === 'searching') {
    details = (
      <p className="text-muted text-xs" data-testid="row-search-progress">
        {jobProgress?.stage === 'verifying' && jobProgress.total > 0
          ? t('status.label.verifying', { done: jobProgress.done, total: jobProgress.total })
          : t('status.label.adding')}
        {item.active_jobs > 0 ? ` · ${t('acq.activeJobs', { count: item.active_jobs })}` : ''}
      </p>
    );
  } else if (tab === 'downloading') {
    primary = (
      <Button
        className={ROW_BUTTON}
        data-testid="row-cancel"
        onClick={() => void cancel()}
        pending={pending}
        size="sm"
        variant="secondary"
      >
        {pending ? null : <X aria-hidden className="size-3.5" />}
        <span className="max-sm:sr-only">{t('acq.cancel')}</span>
      </Button>
    );
    const pin = pinStateText(download?.state, t);
    details = (
      <>
        <ProgressBar aria-label={album.title} max={Math.max(total, 1)} value={done} />
        <p className="text-muted truncate text-xs" data-testid="row-progress">
          {t('acq.progress', { done: formatSize(done, t), percent: percent(done, total), total: formatSize(total, t) })}
          {paused ? ` · ${t('acq.paused')}` : speed > 0 ? ` · ${formatSize(speed, t)}${t('settings.unit.perSec')}` : ''}
          {peers > 0 ? ` · ${t('count.peers', { count: peers })}` : ''}
          {pin ? ` · ${pin}` : ''}
        </p>
        {download?.state === 'failed' && download.error ? (
          <p className="text-danger-fg truncate text-xs">{download.error}</p>
        ) : null}
      </>
    );
  } else if (tab === 'available') {
    primary = (
      <Button
        className={ROW_BUTTON}
        data-testid="row-download"
        onClick={() => void download_()}
        pending={pending}
        size="sm"
        variant="secondary"
      >
        {pending ? null : <Download aria-hidden className="size-3.5" />}
        <span className="max-sm:sr-only">{t('acq.download')}</span>
      </Button>
    );
    details = <p className="text-muted truncate text-xs">{t('acq.availableHint', { count: tracks.total })}</p>;
  } else if (tab === 'downloaded') {
    if (download?.pinned) menu.push({ id: 'unpin', label: t('acq.unpin'), onClick: () => void cancel() });
    menu.push({ danger: true, id: 'delete', label: t('acq.deleteFiles'), onClick: confirmDelete.show });
    details = (
      <p className="text-muted flex items-center gap-2 truncate text-xs">
        <span>{formatSize(download?.bytes_total ?? null, t)}</span>
        {download?.pinned ? <Badge tone="accent">{t('acq.pinned')}</Badge> : null}
      </p>
    );
  }

  return (
    <div
      className="border-divider/70 dark:border-divider-dark/70 flex items-center gap-3 border-b py-3"
      data-testid={`acq-row-${album.id}`}
      style={{ height: ROW_HEIGHT }}
    >
      {onSelect ? (
        <Checkbox
          checked={!!selected}
          hideLabel
          label={t('acq.selectRow', { title: album.title })}
          onCheckedChange={onSelect}
        />
      ) : null}
      <Cover alt={album.title} className="size-14 shrink-0 sm:size-16" src={album.cover_url} thumb={250} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm font-semibold">
          <Link className="hover:underline" to={`/album/${album.id}`}>
            {album.title}
          </Link>
          <span className="text-muted font-normal">
            {' · '}
            <Link className="hover:underline" to={`/artist/${album.artist.id}`}>
              {album.artist.name}
            </Link>
          </span>
        </p>
        {details}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {primary}
        <ActionMenu actions={menu} label={t('menu.actions', { title: album.title })} />
      </div>
      {tab === 'attention' ? (
        <Dialog store={magnet} title={t('sources.addMagnet')}>
          <AddMagnetForm albumId={album.id} />
        </Dialog>
      ) : null}
      {tab === 'downloaded' ? (
        <ConfirmDialog
          confirmAction={async () => {
            try {
              await unpinAlbum(album.id, { deleteFiles: true }, ctx);
              return true;
            } catch (e) {
              toast.error(apiErrorMessage(e, t));
              return false;
            }
          }}
          confirmLabel={t('acq.deleteFiles')}
          description={t('acq.deleteConfirm', { title: album.title })}
          store={confirmDelete}
          title={t('acq.deleteConfirmTitle')}
        />
      ) : null}
    </div>
  );
}
