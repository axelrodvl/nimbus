import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useT } from '@/lib/i18n/provider';
import { usePlayerActions } from '@/lib/player/hooks';
import type { PlayerTrack } from '@/lib/player';
import { cn } from '@/lib/utils';

const itemClass =
  'hover:bg-card dark:hover:bg-card-dark data-[active-item]:bg-card dark:data-[active-item]:bg-card-dark flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none';

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

/** Меню «…» трека в плеере: «Перейти к альбому», «Перейти к артисту», «Убрать из очереди». «В плейлист» добавит шаг 42. */
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
  const go = (to: string) => {
    onNavigate?.();
    void navigate(to);
  };
  return (
    <Ariakit.MenuProvider>
      <Ariakit.MenuButton
        aria-label={t('menu.actions', { title: track.title })}
        className={cn('text-muted rounded-full p-1 hover:text-black dark:hover:text-white', className)}
        data-testid={testId}
      >
        <MoreHorizontal aria-hidden className={iconClassName} />
      </Ariakit.MenuButton>
      <Ariakit.Menu
        className="border-divider dark:border-divider-dark z-[70] min-w-44 rounded-lg border bg-white p-1 text-black shadow-lg dark:bg-black dark:text-white"
        gutter={4}
        portal
      >
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
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}
