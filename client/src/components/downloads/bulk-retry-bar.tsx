import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { retryAlbums, retryMissing } from '@/lib/acquisition/actions';
import { useAcquisitionSummary } from '@/lib/acquisition/hooks';
import { attentionCount, BULK_CONFIRM_THRESHOLD } from '@/lib/acquisition/model';
import type { AcquisitionItem } from '@/lib/api/acquisition';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';

type Props = {
  rows: readonly AcquisitionItem[];
  selected: ReadonlySet<number>;
  onSelectAll: (on: boolean) => void;
  onRetried: () => void;
};

/**
 * Массовые действия вкладки «Требуют внимания»: повтор для всех ненайденных (с подтверждением, если их больше 50)
 * и для выбранных строк; флажок «перепроверить мёртвые раздачи» передаётся как `reset_dead`.
 */
export function BulkRetryBar({ rows, selected, onSelectAll, onRetried }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const summary = useAcquisitionSummary();
  const [resetDead, setResetDead] = useState(false);
  const [pending, setPending] = useState(false);
  const confirm = Ariakit.useDialogStore();
  const total = attentionCount(summary.data);
  const allSelected = rows.length > 0 && selected.size === rows.length;

  async function run(action: () => Promise<number>): Promise<boolean> {
    setPending(true);
    try {
      toast.success(t('acq.queued', { count: await action() }));
      onRetried();
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    } finally {
      setPending(false);
    }
  }

  const retryAll = () => run(() => retryMissing({ resetDead }, { queryClient }));
  const retrySelected = () => run(() => retryAlbums([...selected], { resetDead }, { queryClient }));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="bulk-bar">
      <Button
        data-testid="retry-all"
        disabled={total === 0}
        onClick={() => (total > BULK_CONFIRM_THRESHOLD ? confirm.show() : void retryAll())}
        pending={pending}
        variant="primary"
      >
        {pending ? null : <RefreshCw aria-hidden className="size-4" />}
        {t('acq.retryAll', { count: total })}
      </Button>
      {selected.size > 0 ? (
        <Button data-testid="retry-selected" onClick={() => void retrySelected()} pending={pending} variant="secondary">
          {t('acq.retrySelected', { count: selected.size })}
        </Button>
      ) : null}
      <Checkbox checked={resetDead} label={t('acq.resetDead')} onCheckedChange={setResetDead} />
      {rows.length > 0 ? (
        <Checkbox checked={allSelected} label={t('acq.selectAll')} onCheckedChange={onSelectAll} />
      ) : null}
      <ConfirmDialog
        confirmAction={retryAll}
        confirmLabel={t('acq.retryAll', { count: total })}
        description={t('acq.retryAllConfirm', { count: total })}
        store={confirm}
        title={t('acq.retryAllConfirmTitle')}
        variant="primary"
      />
    </div>
  );
}
