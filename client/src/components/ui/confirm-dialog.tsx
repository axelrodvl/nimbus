import * as Ariakit from '@ariakit/react';
import { useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
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
  primary: 'bg-accent hover:bg-accent-hover',
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
    <Ariakit.Dialog
      store={store}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      backdrop={
        <div onClick={e => e.stopPropagation()} className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
      }
      className="border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-white p-6 shadow-2xl outline-none dark:bg-black"
      unmountOnHide
      hideOnInteractOutside={!isPending}
      hideOnEscape={!isPending}
    >
      <Ariakit.DialogHeading className="text-lg font-bold text-black dark:text-white">{title}</Ariakit.DialogHeading>
      <Ariakit.DialogDescription className="text-muted mt-2 text-sm">{description}</Ariakit.DialogDescription>
      <div className="mt-6 flex justify-end gap-3">
        <Ariakit.DialogDismiss
          className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center justify-center rounded-full border bg-white px-5 py-2 text-sm font-semibold text-black transition-colors disabled:cursor-not-allowed disabled:opacity-50 dark:bg-black dark:text-white"
          disabled={isPending}
        >
          {t('common.cancel')}
        </Ariakit.DialogDismiss>
        <button
          type="button"
          className={`inline-flex min-w-20 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantStyles[variant]}`}
          disabled={isPending}
          onClick={handleConfirm}
        >
          {isPending && <Spinner className="h-4 w-4" />}
          {confirmLabel ?? t('common.confirm')}
        </button>
      </div>
    </Ariakit.Dialog>
  );
}
