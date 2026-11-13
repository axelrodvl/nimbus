'use client';

import * as Ariakit from '@ariakit/react';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { deletePlaylist } from '@/app/actions/playlists';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/providers/i18n-provider';

export function DeletePlaylistButton({ id, name }: { id: string; name: string }) {
  const t = useT();
  const router = useRouter();
  const store = Ariakit.useDialogStore();

  async function confirm() {
    const r = await deletePlaylist(id);
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    toast.success(t('playlist.deleted'));
    router.push('/library?tab=playlists');
    return true;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => store.show()}
        data-testid="delete-playlist"
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {t('playlist.delete')}
      </button>
      <ConfirmDialog
        store={store}
        title={t('playlist.deleteTitle')}
        description={t('playlist.deleteDescription', { title: name })}
        confirmLabel={t('playlist.delete')}
        confirmAction={confirm}
      />
    </>
  );
}
