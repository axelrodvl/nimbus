import { useQueryClient } from '@tanstack/react-query';
import { CloudDownload, HardDrive } from 'lucide-react';
import { useState } from 'react';
import type { MenuAction } from '@/components/downloads/action-menu';
import * as Ariakit from '@ariakit/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { pinAlbum, unpinAlbum } from '@/lib/acquisition/actions';
import { percent } from '@/lib/acquisition/model';
import { isActiveServerDownload } from '@/lib/acquisition/server-state';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { useAlbumServerState, useDownloadProgress } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

/**
 * «Скачать на сервер» на экране альбома: нет → в очереди → прогресс → «На сервере» (с меню «Убрать с сервера»).
 * Состояние вычисляется из синхронизированных треков (`useAlbumServerState`, ревью S11) — известно в первом кадре,
 * без запроса; прогресс — из live-событий. Для альбомов, которые ещё ищутся или не найдены, кнопки нет; без сети она
 * остаётся на месте неактивной. Не путать со скачиванием на устройство (шаг 47).
 */
/** Размер и вид «таблетки» кнопок шапки альбома — общие для «Слушать», «На сервере» и «На устройстве». */
export const HEADER_PILL =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium pointer-coarse:h-11';
const SECONDARY_PILL =
  'border-divider dark:border-divider-dark border bg-white text-black hover:bg-card dark:bg-black dark:text-white dark:hover:bg-card-dark';

/**
 * Действия над скачанным на сервер альбомом для общего меню «…» шапки: «Удалить с сервера» (с подтверждением). Пусто, пока альбом не скачан или нет сети.
 */
export function useServerMenu(albumId: number, title: string) {
  const t = useT();
  const online = useOnline();
  const queryClient = useQueryClient();
  const server = useAlbumServerState(albumId);
  const confirm = Ariakit.useDialogStore();
  const ctx = { queryClient };
  const actions: MenuAction[] = [];
  if (online && server?.state === 'downloaded') {
    actions.push({ danger: true, id: 'remove', label: t('acq.deleteFiles'), onClick: confirm.show });
  }
  const dialog = (
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
      confirmLabel={t('acq.deleteFiles')}
      description={t('acq.deleteConfirm', { title })}
      store={confirm}
      title={t('acq.deleteConfirmTitle')}
    />
  );
  return { actions, dialog };
}

export function ServerDownloadButton({ albumId }: { albumId: number }) {
  const t = useT();
  const online = useOnline();
  const queryClient = useQueryClient();
  const server = useAlbumServerState(albumId);
  const live = useDownloadProgress(albumId);
  const [pending, setPending] = useState(false);
  if (!server || server.state === 'searching' || server.state === 'missing') return null;
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

  const done = live?.bytes_done ?? 0;
  const total = live?.bytes_total ?? 0;

  if (server.state === 'downloaded') {
    return (
      <span className={cn(HEADER_PILL, SECONDARY_PILL)} data-testid="server-download-done">
        <HardDrive aria-hidden className="size-4" />
        {t('acq.server.done')}
      </span>
    );
  }

  if (isActiveServerDownload(server) && server.pin !== 'failed') {
    // Байты знает только live-прогресс: до первого `download.progress` (после перезапуска) — без процентов.
    const label =
      server.pin === 'waiting_source'
        ? t('acq.server.waiting')
        : server.pin === 'queued' && done === 0
          ? t('acq.server.queued')
          : live
            ? t('acq.server.progress', { percent: percent(done, total) })
            : t('acq.server.downloading');
    return (
      <div className="flex items-center gap-1" data-testid="server-download">
        <span
          className={cn(HEADER_PILL, SECONDARY_PILL, 'tabular-nums')}
          data-testid="server-download-progress"
          role="status"
        >
          <CloudDownload aria-hidden className="size-4" />
          {label}
        </span>
        <Button
          aria-label={t('acq.cancel')}
          data-testid="server-download-cancel"
          disabled={!online}
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
      className={cn(HEADER_PILL, 'px-4 font-medium')}
      disabled={!online}
      onClick={() => void run(() => pinAlbum(albumId, ctx))}
      pending={pending}
      variant="secondary"
    >
      {pending ? null : <CloudDownload aria-hidden className="size-4" />}
      {server.pin === 'failed' ? t('acq.server.retry') : t('acq.server.download')}
    </Button>
  );
}
