import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Cover } from '@/components/library/cover';
import { useT } from '@/lib/i18n/provider';
import { useCanPlay, usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import type { PlayerTrack } from '@/lib/player';
import { useTrackView } from '@/lib/store/hooks';
import { cn, formatDuration } from '@/lib/utils';

const rowButton =
  'text-muted rounded p-1 opacity-0 hover:text-black focus:opacity-100 focus-visible:ring-accent/40 focus-visible:ring-2 focus-visible:outline-none group-hover/q:opacity-100 disabled:hidden dark:hover:text-white';

/** Выезжающая справа панель очереди: текущий трек и «Далее» (переход, удаление, перестановка). */
export function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const player = usePlayerActions();
  const { queue, index } = usePlayerState(useShallow(s => ({ index: s.index, queue: s.queue })));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const current = queue[index];
  const upcoming = queue.map((track, i) => ({ i, track })).filter(({ i }) => i > index);

  return (
    <aside
      aria-hidden={!open}
      aria-label={t('player.queue')}
      className={cn(
        'border-divider dark:border-divider-dark fixed top-0 right-0 bottom-0 z-[60] flex w-80 max-w-[90vw] flex-col border-l bg-white transition-transform duration-200 dark:bg-[#181818]',
        // Тень только у открытой панели: у закрытой она «просачивалась» полосой у правого края экрана.
        open ? 'translate-x-0 shadow-2xl' : 'translate-x-full',
      )}
      data-testid="queue-panel"
      inert={!open}
    >
      <header className="border-divider dark:border-divider-dark flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t('player.queue')}</h2>
        <button
          aria-label={t('queue.closeLabel')}
          className="text-muted p-1 hover:text-black dark:hover:text-white"
          onClick={onClose}
          type="button"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {current ? (
          <>
            <p className="text-muted px-2 pb-1 text-xs font-medium tracking-wide uppercase">{t('queue.nowPlaying')}</p>
            <QueueRow current onPlay={() => player.playIndex(index)} track={current} />
            <p className="text-muted px-2 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">{t('queue.next')}</p>
            {upcoming.length === 0 ? (
              <p className="text-muted px-2 py-2 text-xs">{t('queue.noMore')}</p>
            ) : (
              upcoming.map(({ i, track }) => (
                <QueueRow
                  canDown={i < queue.length - 1}
                  canUp={i > index + 1}
                  key={`${track.id}-${i}`}
                  onDown={() => player.moveInQueue(i, i + 1)}
                  onPlay={() => player.playIndex(i)}
                  onRemove={() => player.removeFromQueue(i)}
                  onUp={() => player.moveInQueue(i, i - 1)}
                  track={track}
                />
              ))
            )}
          </>
        ) : (
          <p className="text-muted px-2 py-2 text-sm">{t('queue.empty')}</p>
        )}
      </div>
    </aside>
  );
}

function QueueRow({
  track,
  current,
  onPlay,
  onRemove,
  onUp,
  onDown,
  canUp,
  canDown,
}: {
  track: PlayerTrack;
  current?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  canUp?: boolean;
  canDown?: boolean;
}) {
  const t = useT();
  // Актуальный статус — из библиотеки (снимок в очереди мог устареть).
  const live = useTrackView(track.id);
  const canPlay = useCanPlay();
  const playable = canPlay({ id: track.id, status: live?.status ?? track.status });
  return (
    <div
      className={cn(
        'group/q flex items-center gap-2 rounded-md px-2 py-1.5',
        current ? 'bg-card/40 dark:bg-card-dark/40' : 'hover:bg-card/60 dark:hover:bg-card-dark/60',
        !playable && 'opacity-50',
      )}
      data-testid="queue-row"
      data-track-id={track.id}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
        disabled={!playable}
        onClick={onPlay}
        type="button"
      >
        <Cover alt={track.title} className="size-8 rounded" src={track.coverUrl} />
        <span className="flex min-w-0 flex-col">
          <span className={cn('truncate text-sm', current && 'text-accent-fg font-medium')}>{track.title}</span>
          <span className="text-muted truncate text-xs">{track.artist}</span>
        </span>
      </button>
      {track.durationMs ? (
        <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.durationMs / 1000))}</span>
      ) : null}
      {onUp ? (
        <button
          aria-label={t('queue.moveUp', { title: track.title })}
          className={rowButton}
          disabled={!canUp}
          onClick={onUp}
          type="button"
        >
          <ChevronUp className="size-3.5" />
        </button>
      ) : null}
      {onDown ? (
        <button
          aria-label={t('queue.moveDown', { title: track.title })}
          className={rowButton}
          disabled={!canDown}
          onClick={onDown}
          type="button"
        >
          <ChevronDown className="size-3.5" />
        </button>
      ) : null}
      {onRemove ? (
        <button
          aria-label={t('queue.remove', { title: track.title })}
          className={rowButton}
          onClick={onRemove}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
