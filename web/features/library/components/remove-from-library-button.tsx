'use client';

import * as Ariakit from '@ariakit/react';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { removeFromLibrary } from '@/app/actions/library';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { Route } from 'next';

type Props = {
  type: 'artist' | 'album';
  id: number;
  title: string;
  /** Куда вернуться после удаления. */
  redirectTo: Route;
};

export function RemoveFromLibraryButton({ type, id, title, redirectTo }: Props) {
  const router = useRouter();
  const store = Ariakit.useDialogStore();

  async function confirm() {
    const result = await removeFromLibrary(type, id);
    if (!result.ok) {
      toast.error(result.message);
      return false;
    }
    toast.success('Удалено из библиотеки');
    router.push(redirectTo);
    return true;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => store.show()}
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        Удалить из библиотеки
      </button>
      <ConfirmDialog
        store={store}
        title="Удалить из библиотеки?"
        description={`«${title}» исчезнет из библиотеки. Найденные источники сохранятся.`}
        confirmLabel="Удалить"
        confirmAction={confirm}
      />
    </>
  );
}
