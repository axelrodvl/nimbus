import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '@/lib/i18n/provider';
import { useHasNext, usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { cn } from '@/lib/utils';

export function ToggleButton({
  label,
  active,
  onClick,
  children,
  className,
  testId,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'focus-visible:ring-accent/40 items-center justify-center rounded-full p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none',
        active ? 'text-accent' : 'text-muted hover:text-black dark:hover:text-white',
        className,
      )}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function SkipButton({
  direction,
  onClick,
  disabled,
  big,
}: {
  direction: 'back' | 'forward';
  onClick: () => void;
  disabled?: boolean;
  /** Крупная кнопка полноэкранного плеера. */
  big?: boolean;
}) {
  const t = useT();
  const Icon = direction === 'back' ? SkipBack : SkipForward;
  return (
    <button
      aria-label={direction === 'back' ? t('player.previous') : t('player.next')}
      className={cn(
        'focus-visible:ring-accent/40 rounded-full p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40',
        big ? 'p-2 transition-transform active:scale-90' : 'text-muted hover:text-black dark:hover:text-white',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon className={big ? 'size-9' : 'size-4'} fill={big ? 'currentColor' : undefined} />
    </button>
  );
}

export function PlayPauseButton({
  isPlaying,
  loading,
  onClick,
  disabled,
  big,
}: {
  isPlaying: boolean;
  loading?: boolean;
  onClick: () => void;
  disabled?: boolean;
  big?: boolean;
}) {
  const t = useT();
  const icon = big ? 'size-14' : 'size-4';
  return (
    <button
      aria-label={isPlaying ? t('player.pause') : t('player.play')}
      className={cn(
        'focus-visible:ring-accent/40 flex items-center justify-center rounded-full transition-transform focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40',
        big ? 'p-2 active:scale-90' : 'size-8 bg-black text-white hover:scale-105 dark:bg-white dark:text-black',
      )}
      data-playing={isPlaying || undefined}
      data-testid={big ? 'full-player-play-pause' : 'player-play-pause'}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {loading ? (
        <Loader2 className={cn(icon, 'animate-spin')} />
      ) : isPlaying ? (
        <Pause className={icon} fill="currentColor" />
      ) : (
        <Play className={cn(icon, !big && 'translate-x-px')} fill="currentColor" />
      )}
    </button>
  );
}

export const isConnecting = (status: string) => status === 'loading' || status === 'buffering';

/** Перемешивание, предыдущий, пуск/пауза, следующий, повтор — настольная панель. */
export function Transport() {
  const t = useT();
  const player = usePlayerActions();
  const hasNext = useHasNext();
  const { hasTrack, isPlaying, connecting, shuffle } = usePlayerState(
    useShallow(s => ({
      connecting: isConnecting(s.status),
      hasTrack: s.index >= 0 && s.queue.length > 0,
      isPlaying: s.isPlaying,
      shuffle: s.shuffle,
    })),
  );
  return (
    <div className="flex items-center gap-4">
      <ToggleButton
        active={shuffle}
        className="hidden sm:inline-flex"
        label={t('player.shuffle')}
        onClick={player.toggleShuffle}
        testId="player-shuffle"
      >
        <Shuffle className="size-4" />
      </ToggleButton>
      <SkipButton direction="back" disabled={!hasTrack} onClick={player.previous} />
      <PlayPauseButton
        disabled={!hasTrack}
        isPlaying={isPlaying}
        loading={connecting && isPlaying}
        onClick={player.togglePlayPause}
      />
      <SkipButton direction="forward" disabled={!hasTrack || !hasNext} onClick={player.next} />
      <RepeatButton className="hidden sm:inline-flex" testId="player-repeat" />
    </div>
  );
}

export function RepeatButton({
  className,
  testId,
  size = 'size-4',
}: {
  className?: string;
  testId?: string;
  size?: string;
}) {
  const t = useT();
  const player = usePlayerActions();
  const repeat = usePlayerState(s => s.repeat);
  const Icon = repeat === 'one' ? Repeat1 : Repeat;
  return (
    <ToggleButton
      active={repeat !== 'off'}
      className={className}
      label={
        repeat === 'off' ? t('player.repeat.off') : repeat === 'all' ? t('player.repeat.all') : t('player.repeat.one')
      }
      onClick={player.cycleRepeat}
      testId={testId}
    >
      <Icon className={size} />
    </ToggleButton>
  );
}
