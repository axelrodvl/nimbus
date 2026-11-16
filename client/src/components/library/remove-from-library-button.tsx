import * as Ariakit from '@ariakit/react';
import { Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiError } from '@/lib/api/errors';
import { useT } from '@/lib/i18n/provider';
import { removeFromLibrary } from '@/lib/library/actions';

type Props = {
  type: 'artist' | 'album';
  id: number;
  title: string;
  /** Куда вернуться после удаления. */
  redirectTo: string;
};

/**
 * Кнопка «Удалить» с подтверждением. Удаление оптимистично: объект исчезает из store сразу, при ошибке
 * возвращается и показывается toast.
 */
export function useRemoveFromLibrary({ type, id, title, redirectTo }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const store = Ariakit.useDialogStore();

  async function confirm() {
    try {
      await removeFromLibrary(type, id);
    } catch (e) {
      // Store уже откатил изменение; остаёмся на экране.
      toast.error(e instanceof ApiError && e.code !== 'unknown' ? e.message : t('common.loadFailed'));
      return false;
    }
    toast.success(t('toast.removed'));
    void navigate(redirectTo);
    return true;
  }

  const dialog = (
    <ConfirmDialog
      confirmAction={confirm}
      confirmLabel={t('remove.confirm')}
      description={t('remove.description', { title })}
      store={store}
      title={t('remove.title')}
    />
  );
  return { dialog, open: () => store.show() };
}

export function RemoveFromLibraryButton(props: Props) {
  const t = useT();
  const { dialog, open } = useRemoveFromLibrary(props);
  return (
    <>
      <button
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark focus-visible:ring-accent/40 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
        onClick={open}
        type="button"
      >
        <Trash2 aria-hidden className="size-4" />
        {t('remove.button')}
      </button>
      {dialog}
    </>
  );
}
