import * as Ariakit from '@ariakit/react';
import { Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiErrorMessage } from '@/lib/api/error-message';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { deletePlaylist } from '@/lib/playlists/actions';

/**
 * «Удалить плейлист» с подтверждением. Оптимистично: плейлист исчезает сразу, страница закрывается; при ошибке он
 * возвращается в список и показывается toast.
 */
export function DeletePlaylistButton({ id, name }: { id: number; name: string }) {
  const t = useT();
  const navigate = useNavigate();
  const store = Ariakit.useDialogStore();

  async function confirm() {
    const request = deletePlaylist(id);
    // Плейлист уже убран из store (оптимистично) — уходим со страницы, не показывая «не найдено»
    // на время запроса. Без сети store не менялся: остаёмся на месте и показываем ошибку.
    const gone = !appData().library.getState().playlists.has(id);
    if (gone) void navigate('/library/playlists');
    try {
      await request;
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    }
    toast.success(t('playlist.deleted'));
    return true;
  }

  return (
    <>
      <Button data-testid="delete-playlist" onClick={() => store.show()} variant="secondary">
        <Trash2 aria-hidden className="size-4" />
        {t('playlist.delete')}
      </Button>
      <ConfirmDialog
        confirmAction={confirm}
        confirmLabel={t('playlist.delete')}
        description={t('playlist.deleteDescription', { title: name })}
        store={store}
        title={t('playlist.deleteTitle')}
      />
    </>
  );
}
