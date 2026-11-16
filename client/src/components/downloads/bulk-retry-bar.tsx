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
 * Массовые действия раздела «Требуют внимания»: повтор для всех ненайденных (с подтверждением, если их больше 50),
 * под ним — строка выбора над списком («выбрать все», «повторить для выбранных»). Флажок «перепроверить мёртвые
 * раздачи» относится к обоим повторам и уходит как `reset_dead`.
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
    <div className="mb-1 flex flex-col gap-3" data-testid="bulk-bar">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
        <Checkbox checked={resetDead} label={t('acq.resetDead')} onCheckedChange={setResetDead} plain />
      </div>
      {rows.length > 0 ? (
        <div
          className="border-divider/70 dark:border-divider-dark/70 flex min-h-11 flex-wrap items-center gap-2 border-b pb-1"
          data-testid="selection-bar"
        >
          <Checkbox checked={allSelected} label={t('acq.selectAll')} onCheckedChange={onSelectAll} plain />
          {selected.size > 0 ? (
            <Button
              className="ml-auto"
              data-testid="retry-selected"
              onClick={() => void retrySelected()}
              pending={pending}
              size="sm"
              variant="secondary"
            >
              {t('acq.retrySelected', { count: selected.size })}
            </Button>
          ) : null}
        </div>
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
