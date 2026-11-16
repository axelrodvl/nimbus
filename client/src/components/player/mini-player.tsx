import { ListMusic } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Cover } from '@/components/library/cover';
import { Marquee } from '@/components/ui/marquee';
import { useT } from '@/lib/i18n/provider';
import { currentTrack } from '@/lib/player/engine';
import { useHasNext, usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { DownloadInfo } from './download-info';
import { ProgressRow } from './progress-row';
import { isConnecting, PlayPauseButton, SkipButton } from './transport';

/** Мобильный мини-плеер (до `sm`): виден, пока в плеере есть трек. Нажатие на трек открывает полноэкранный. */
export function MiniPlayer({ onOpenFull, onToggleQueue }: { onOpenFull: () => void; onToggleQueue: () => void }) {
  const t = useT();
  const player = usePlayerActions();
  const track = usePlayerState(currentTrack);
  const hasNext = useHasNext();
  const { isPlaying, connecting } = usePlayerState(
    useShallow(s => ({ connecting: isConnecting(s.status), isPlaying: s.isPlaying })),
  );
  if (!track) return null;
  return (
    <div
      className="border-divider dark:border-divider-dark shrink-0 border-t bg-white px-4 py-2 sm:hidden dark:bg-[#181818]"
      data-testid="mini-player"
      style={{ viewTransitionName: 'player-bar' }}
    >
      <div className="flex items-center gap-3">
        <button
          aria-label={t('player.expand')}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          data-testid="player-expand"
          onClick={onOpenFull}
          type="button"
        >
          <Cover alt={track.title} className="size-12 rounded-sm" src={track.coverUrl} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Marquee className="text-sm font-medium text-black dark:text-white">{track.title}</Marquee>
            <span className="text-muted truncate text-xs">{track.artist}</span>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <SkipButton direction="back" onClick={player.previous} />
          <PlayPauseButton isPlaying={isPlaying} loading={connecting && isPlaying} onClick={player.togglePlayPause} />
          <SkipButton direction="forward" disabled={!hasNext} onClick={player.next} />
          <button
            aria-label={t('player.queue')}
            className="text-muted p-1 hover:text-black dark:hover:text-white"
            onClick={onToggleQueue}
            type="button"
          >
            <ListMusic className="size-4" />
          </button>
        </div>
      </div>
      <ProgressRow className="mt-2" />
      <DownloadInfo className="mt-1" />
    </div>
  );
}
