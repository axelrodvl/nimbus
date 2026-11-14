import { useQueryClient } from '@tanstack/react-query';
import { CloudDownload, HardDrive } from 'lucide-react';
import { useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { toast } from 'sonner';
import { ActionMenu } from '@/components/downloads/action-menu';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { pinAlbum, unpinAlbum } from '@/lib/acquisition/actions';
import { useAlbumAcquisition } from '@/lib/acquisition/hooks';
import { isActiveDownload, percent } from '@/lib/acquisition/model';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { useDownloadProgress } from '@/lib/store/hooks';

/**
 * «Скачать на сервер» на экране альбома: нет → в очереди → прогресс → «На сервере» (с меню «Убрать с сервера»).
 * Состояние берётся с сервера (`GET /api/acquisition?album_ids=`) и живёт на событиях; без сети и для альбомов,
 * которые ещё ищутся или не найдены, кнопки нет. Не путать со скачиванием на устройство (шаг 47).
 */
export function ServerDownloadButton({ albumId, title }: { albumId: number; title: string }) {
  const t = useT();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useAlbumAcquisition(albumId, online);
  const live = useDownloadProgress(albumId);
  const [pending, setPending] = useState(false);
  const confirm = Ariakit.useDialogStore();
  const item = query.data;
  if (!online || !item || item.state === 'searching' || item.state === 'missing') return null;
  const ctx = { queryClient };

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setPending(false);
    }
  }

  const d = item.download;
  const active = isActiveDownload(item);
  const done = live?.bytes_done ?? d?.bytes_done ?? 0;
  const total = live?.bytes_total ?? d?.bytes_total ?? 0;

  if (item.state === 'downloaded') {
    return (
      <div className="flex items-center gap-1" data-testid="server-download">
        <span
          className="border-divider dark:border-divider-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
          data-testid="server-download-done"
        >
          <HardDrive aria-hidden className="size-4" />
          {t('acq.server.done')}
        </span>
        <ActionMenu
          actions={[
            ...(d?.pinned
              ? [
                  {
                    id: 'unpin',
                    label: t('acq.server.keepFiles'),
                    onClick: () => void run(() => unpinAlbum(albumId, { deleteFiles: false }, ctx)),
                  },
                ]
              : []),
            { danger: true, id: 'remove', label: t('acq.server.remove'), onClick: confirm.show },
          ]}
          label={t('menu.actions', { title })}
          testId="server-download-menu"
        />
        <ConfirmDialog
          confirmAction={async () => {
            try {
              await unpinAlbum(albumId, { deleteFiles: true }, ctx);
              return true;
            } catch (e) {
              toast.error(apiErrorMessage(e, t));
              return false;
            }
          }}
          confirmLabel={t('acq.server.remove')}
          description={t('acq.deleteConfirm', { title })}
          store={confirm}
          title={t('acq.deleteConfirmTitle')}
        />
      </div>
    );
  }

  if (active && d?.state !== 'failed') {
    const label =
      d?.state === 'waiting_source'
        ? t('acq.server.waiting')
        : d?.state === 'queued' && done === 0
          ? t('acq.server.queued')
          : t('acq.server.progress', { percent: percent(done, total) });
    return (
      <div className="flex items-center gap-1" data-testid="server-download">
        <span
          className="border-divider dark:border-divider-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold tabular-nums"
          data-testid="server-download-progress"
          role="status"
        >
          <CloudDownload aria-hidden className="size-4" />
          {label}
        </span>
        <Button
          aria-label={t('acq.cancel')}
          data-testid="server-download-cancel"
          onClick={() => void run(() => unpinAlbum(albumId, { deleteFiles: false }, ctx))}
          pending={pending}
          size="sm"
          variant="ghost"
        >
          {t('acq.cancel')}
        </Button>
      </div>
    );
  }

  return (
    <Button
      data-testid="server-download"
      onClick={() => void run(() => pinAlbum(albumId, ctx))}
      pending={pending}
      variant="secondary"
    >
      {pending ? null : <CloudDownload aria-hidden className="size-4" />}
      {d?.state === 'failed' ? t('acq.server.retry') : t('acq.server.download')}
    </Button>
  );
}
