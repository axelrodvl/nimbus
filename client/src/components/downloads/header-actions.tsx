import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { collectAvailableIds, pinAlbums, setAllPaused } from '@/lib/acquisition/actions';
import { useAcquisitionSummary, useEngineTorrents } from '@/lib/acquisition/hooks';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { useStorage } from '@/lib/settings/hooks';
import { formatSize } from '@/lib/sources/format';

/** Пауза всех загрузок / возобновление: подпись и состояние берутся из ответа сервера, на время запроса кнопка заблокирована. */
export function PauseAllButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const engine = useEngineTorrents(false);
  const [pending, setPending] = useState(false);
  const paused = engine.data?.paused ?? false;
  return (
    <Button
      data-testid="pause-all"
      disabled={!engine.data}
      onClick={async () => {
        setPending(true);
        try {
          await setAllPaused(!paused, { queryClient });
        } catch (e) {
          toast.error(apiErrorMessage(e, t));
        } finally {
          setPending(false);
        }
      }}
      pending={pending}
      variant="secondary"
    >
      {pending ? null : paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
      {paused ? t('acq.resumeAll') : t('acq.pauseAll')}
    </Button>
  );
}

/** «Скачать всё доступное»: подтверждение с числом альбомов, затем закрепление с параллельностью 4 и счётчиком. */
export function DownloadAllButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const summary = useAcquisitionSummary();
  const confirm = Ariakit.useDialogStore();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const available = summary.data?.available ?? 0;

  async function run(): Promise<boolean> {
    try {
      const ids = await collectAvailableIds({ queryClient });
      setProgress({ done: 0, total: ids.length });
      const result = await pinAlbums(ids, { queryClient }, (done, total) => setProgress({ done, total }));
      toast[result.failed > 0 ? 'warning' : 'success'](
        result.failed > 0
          ? t('acq.downloadAllFailed', { done: result.done - result.failed, failed: result.failed })
          : t('acq.downloadAllDone', { count: result.done }),
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setProgress(null);
    }
    return true;
  }

  return (
    <>
      <Button
        data-testid="download-all"
        disabled={available === 0 || progress !== null}
        onClick={confirm.show}
        variant="secondary"
      >
        <Download aria-hidden className="size-4" />
        {progress ? t('acq.downloadAllProgress', progress) : t('acq.downloadAll')}
      </Button>
      <ConfirmDialog
        confirmAction={() => {
          void run();
          return Promise.resolve(true);
        }}
        confirmLabel={t('acq.downloadAll')}
        description={t('acq.downloadAllConfirm', { count: available })}
        store={confirm}
        title={t('acq.downloadAll')}
        variant="primary"
      />
    </>
  );
}

/** Заполненность хранилища сервера одной строкой со ссылкой на настройки. */
export function StorageLine() {
  const t = useT();
  const { data } = useStorage();
  if (!data) return null;
  return (
    <p className="text-muted text-sm" data-testid="acq-storage">
      {t('acq.storage', { limit: formatSize(data.limit_bytes, t), used: formatSize(data.used_bytes, t) })}
      {' · '}
      <Link className="text-accent hover:underline" to="/settings/storage">
        {t('acq.storageLink')}
      </Link>
    </p>
  );
}
