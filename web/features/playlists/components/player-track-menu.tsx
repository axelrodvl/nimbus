'use client';

import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { AddToPlaylistDialog } from '@/features/playlists/components/add-to-playlist-dialog';
import { cn } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';

// Меню «…» текущего трека в плеере (пока — «Добавить в плейлист»). Поверх полноэкранного плеера и панели очереди.
export function PlayerTrackMenu({
  trackId,
  title,
  className,
  iconClassName = 'h-4 w-4',
}: {
  trackId: number;
  title: string;
  className?: string;
  iconClassName?: string;
}) {
  const t = useT();
  const dialog = Ariakit.useDialogStore();
  return (
    <>
      <Ariakit.MenuProvider>
        <Ariakit.MenuButton
          aria-label={t('menu.actions', { title })}
          data-testid="player-track-menu"
          className={cn('text-muted p-1 hover:text-black dark:hover:text-white', className)}
        >
          <MoreHorizontal className={iconClassName} aria-hidden />
        </Ariakit.MenuButton>
        <Ariakit.Menu
          gutter={4}
          portal
          className="border-divider dark:border-divider-dark z-[70] min-w-44 rounded-lg border bg-white p-1 text-black shadow-lg dark:bg-black dark:text-white"
        >
          <Ariakit.MenuItem
            className="hover:bg-card dark:hover:bg-card-dark data-[active-item]:bg-card dark:data-[active-item]:bg-card-dark flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none"
            onClick={() => dialog.show()}
          >
            {t('playlist.addTo')}
          </Ariakit.MenuItem>
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
      <AddToPlaylistDialog store={dialog} trackId={trackId} title={title} />
    </>
  );
}
