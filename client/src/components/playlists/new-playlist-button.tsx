import * as Ariakit from '@ariakit/react';
import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { createPlaylist } from '@/lib/playlists/actions';
import { NewPlaylistForm } from './new-playlist-form';

/** «Новый плейлист»: окно с названием; после создания открывается страница нового плейлиста. */
export function NewPlaylistButton() {
  const t = useT();
  const navigate = useNavigate();
  const store = Ariakit.useDialogStore();

  async function create(name: string) {
    try {
      const id = await createPlaylist(name);
      toast.success(t('playlist.created'));
      store.hide();
      void navigate(`/playlist/${id}`);
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    }
  }

  return (
    <>
      <Button data-testid="new-playlist" onClick={() => store.show()} variant="secondary">
        <Plus aria-hidden className="size-4" />
        {t('playlist.new')}
      </Button>
      <Dialog store={store} title={t('playlist.new')}>
        <NewPlaylistForm onSubmit={create} />
      </Dialog>
    </>
  );
}
