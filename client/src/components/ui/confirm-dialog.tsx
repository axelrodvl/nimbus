import * as Ariakit from '@ariakit/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useT } from '@/lib/i18n/provider';

type Variant = 'danger' | 'primary';

type Props = {
  store: Ariakit.DialogStore;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: Variant;
  /** Возвращает `true`, если действие выполнено и диалог можно закрыть. */
  confirmAction: () => Promise<boolean>;
};

const variantStyles: Record<Variant, string> = {
  danger: 'bg-danger hover:bg-danger/85',
  primary: '',
};

export function ConfirmDialog({ store, title, description, confirmLabel, variant = 'danger', confirmAction }: Props) {
  const t = useT();
  const [isPending, setIsPending] = useState(false);

  async function handleConfirm() {
    setIsPending(true);
    try {
      if (await confirmAction()) store.hide();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog description={description} locked={isPending} store={store} title={title} variant="sheet" wrapDescription>
      <div className="mt-3 flex justify-end gap-3">
        <Ariakit.DialogDismiss render={<Button disabled={isPending} variant="secondary" />}>
          {t('common.cancel')}
        </Ariakit.DialogDismiss>
        <Button className={`min-w-20 text-white ${variantStyles[variant]}`} onClick={handleConfirm} pending={isPending}>
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
