import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { menuItemClass as itemClass } from '@/components/library/row-menu';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { useTrackOfflineMenu } from '@/components/offline/track-offline';
import { useTrackDialogs } from '@/components/library/track-dialogs';
import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '@/lib/i18n/provider';
import { usePlayerActions } from '@/lib/player/hooks';
import type { PlayerTrack } from '@/lib/player';
import { cn } from '@/lib/utils';

type Props = {
  track: PlayerTrack;
  /** Индекс в очереди: если задан, в меню есть «Убрать из очереди» (текущий трек не удаляется). */
  queueIndex?: number;
  /** Вызывается перед переходом по ссылке (закрыть полноэкранный плеер). */
  onNavigate?: () => void;
  className?: string;
  iconClassName?: string;
  testId?: string;
};

/** Меню «…» трека в плеере: «В плейлист», «Перейти к альбому», «Перейти к артисту», «Убрать из очереди». */
export function TrackMenu({
  track,
  queueIndex,
  onNavigate,
  className,
  iconClassName = 'size-4',
  testId = 'player-track-menu',
}: Props) {
  const t = useT();
  const navigate = useNavigate();
  const player = usePlayerActions();
  const dialogs = useTrackDialogs();
  const opener = useRef<HTMLButtonElement>(null);
  const offlineMenu = useTrackOfflineMenu({ albumId: track.albumId, id: track.id, title: track.title }, opener);
  const go = (to: string) => {
    onNavigate?.();
    void navigate(to);
  };
  return (
    <>
      <Ariakit.MenuProvider>
        <Ariakit.MenuButton
          aria-label={t('menu.actions', { title: track.title })}
          className={cn('text-muted rounded-full p-1 hover:text-black dark:hover:text-white', className)}
          data-menu-trigger
          data-testid={testId}
          ref={opener}
        >
          <MoreHorizontal aria-hidden className={iconClassName} />
        </Ariakit.MenuButton>
        <MenuSheet>
          <Ariakit.MenuItem className={itemClass} onClick={() => dialogs.addToPlaylist(track.id, opener)}>
            {t('playlist.addTo')}
          </Ariakit.MenuItem>
          {offlineMenu.item}
          {track.albumId !== undefined ? (
            <Ariakit.MenuItem className={itemClass} onClick={() => go(`/album/${track.albumId}`)}>
              {t('player.goAlbum')}
            </Ariakit.MenuItem>
          ) : null}
          {track.artistId !== undefined ? (
            <Ariakit.MenuItem className={itemClass} onClick={() => go(`/artist/${track.artistId}`)}>
              {t('player.goArtist')}
            </Ariakit.MenuItem>
          ) : null}
          {queueIndex !== undefined ? (
            <Ariakit.MenuItem className={itemClass} onClick={() => player.removeFromQueue(queueIndex)}>
              {t('queue.removeShort')}
            </Ariakit.MenuItem>
          ) : null}
        </MenuSheet>
      </Ariakit.MenuProvider>
    </>
  );
}
