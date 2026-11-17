import * as Ariakit from '@ariakit/react';
import { useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { useTrackDialogs } from '@/components/library/track-dialogs';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { useTrackOfflineMenu } from '@/components/offline/track-offline';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { removeTrackFromPlaylist } from '@/lib/playlists/actions';
import { retryTrackSearch } from '@/lib/sources/actions';
import { useQueryClient } from '@tanstack/react-query';
import type { TrackStatus } from '@/lib/store/selectors';

export const menuItemClass =
  'hover:bg-card dark:hover:bg-card-dark data-[active-item]:bg-card dark:data-[active-item]:bg-card-dark flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none pointer-coarse:py-3 pointer-coarse:text-base';

type Props = {
  trackId: number;
  albumId: number;
  title: string;
  status: TrackStatus;
  /** Список — пользовательский плейлист: в меню есть «Убрать из плейлиста». */
  playlistId?: number;
};

/** Меню «…» строки трека в списках: плейлист, источник, повтор поиска (для ненайденных). */
export function RowMenu({ trackId, albumId, title, status, playlistId }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const dialogs = useTrackDialogs();
  const opener = useRef<HTMLButtonElement>(null);
  const offlineMenu = useTrackOfflineMenu({ albumId, id: trackId, title }, opener);

  async function removeFromPlaylist() {
    if (playlistId === undefined) return;
    try {
      await removeTrackFromPlaylist(playlistId, trackId);
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    }
  }

  async function retry() {
    try {
      await retryTrackSearch(trackId, albumId, { queryClient });
      toast.success(t('sources.retryStarted'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    }
  }

  return (
    <Ariakit.MenuProvider>
      <Ariakit.MenuButton
        aria-label={t('menu.actions', { title })}
        className="text-gray hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
        data-menu-trigger
        data-testid="track-menu"
        ref={opener}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </Ariakit.MenuButton>
      <MenuSheet>
        <Ariakit.MenuItem className={menuItemClass} onClick={() => dialogs.addToPlaylist(trackId, opener)}>
          {t('playlist.addTo')}
        </Ariakit.MenuItem>
        {playlistId !== undefined ? (
          <Ariakit.MenuItem className={menuItemClass} onClick={() => void removeFromPlaylist()}>
            {t('playlist.removeTrack')}
          </Ariakit.MenuItem>
        ) : null}
        <Ariakit.MenuItem className={menuItemClass} onClick={() => dialogs.chooseSource(trackId, opener)}>
          {t('menu.chooseSource')}
        </Ariakit.MenuItem>
        {offlineMenu.item}
        {status === 'not_found' ? (
          <Ariakit.MenuItem className={menuItemClass} onClick={() => void retry()}>
            {t('sources.retry')}
          </Ariakit.MenuItem>
        ) : null}
      </MenuSheet>
    </Ariakit.MenuProvider>
  );
}
