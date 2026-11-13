'use client';

import * as Ariakit from '@ariakit/react';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createPlaylist } from '@/app/actions/playlists';
import { NewPlaylistForm } from '@/features/playlists/components/new-playlist-form';
import { useT } from '@/providers/i18n-provider';

export function NewPlaylistButton() {
  const t = useT();
  const router = useRouter();
  const store = Ariakit.useDialogStore();

  async function create(name: string) {
    const r = await createPlaylist(name);
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    toast.success(t('playlist.created'));
    store.hide();
    router.push(`/playlist/${r.playlist.id}`);
    return true;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => store.show()}
        data-testid="new-playlist"
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t('playlist.new')}
      </button>
      <Ariakit.Dialog
        store={store}
        backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
        className="border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border bg-white p-6 shadow-2xl outline-none dark:bg-black"
        unmountOnHide
      >
        <Ariakit.DialogHeading className="text-lg font-bold">{t('playlist.new')}</Ariakit.DialogHeading>
        <NewPlaylistForm onSubmit={create} />
      </Ariakit.Dialog>
    </>
  );
}
