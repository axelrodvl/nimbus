'use client';

import { X } from 'lucide-react';
import { useEffect } from 'react';
import { Cover } from '@/components/ui/cover';
import { cn, formatDuration } from '@/lib/utils';
import { useTrackStatus } from '@/providers/live-library-provider';
import { canPlayStatus } from '@/providers/player/engine';
import { usePlayer } from '@/providers/player-provider';
import type { Track } from '@/types/track';

// Выезжающая справа панель очереди: текущий трек и «Далее».
export function QueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { queue, queueIndex, playIndex, removeFromQueue } = usePlayer();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const current = queue[queueIndex];
  const upcoming = queue.map((t, i) => ({ i, t })).filter(({ i }) => i > queueIndex);

  return (
    <aside
      data-testid="queue-panel"
      aria-label="Очередь"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'border-divider dark:border-divider-dark fixed top-0 right-0 bottom-0 z-40 flex w-80 max-w-[90vw] flex-col border-l bg-white shadow-2xl transition-transform duration-200 dark:bg-[#181818]',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="border-divider dark:border-divider-dark flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Очередь</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть очередь"
          className="text-muted p-1 hover:text-black dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {current ? (
          <>
            <p className="text-muted px-2 pb-1 text-xs font-medium tracking-wide uppercase">Сейчас играет</p>
            <QueueRow track={current} current onPlay={() => playIndex(queueIndex)} />
            <p className="text-muted px-2 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">Далее</p>
            {upcoming.length === 0 ? (
              <p className="text-muted px-2 py-2 text-xs">Больше треков в очереди нет</p>
            ) : (
              upcoming.map(({ i, t }) => (
                <QueueRow
                  key={`${t.id}-${i}`}
                  track={t}
                  onPlay={() => playIndex(i)}
                  onRemove={() => removeFromQueue(i)}
                />
              ))
            )}
          </>
        ) : (
          <p className="text-muted px-2 py-2 text-sm">Очередь пуста</p>
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
}: {
  track: Track;
  current?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  const live = useTrackStatus(track.id, track.status, null);
  const playable = canPlayStatus(live.status);
  return (
    <div
      data-testid="queue-row"
      data-track-id={track.id}
      className={cn(
        'group/q flex items-center gap-2 rounded-md px-2 py-1.5',
        current ? 'bg-card/40 dark:bg-card-dark/40' : 'hover:bg-card/60 dark:hover:bg-card-dark/60',
        !playable && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={onPlay}
        disabled={!playable}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
      >
        <Cover src={track.coverUrl} alt={track.title} size="sm" className="!h-8 !w-8 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className={cn('truncate text-sm', current && 'text-accent font-medium')}>{track.title}</span>
          <span className="text-muted truncate text-xs">{track.artist}</span>
        </span>
      </button>
      {track.durationMs ? (
        <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.durationMs / 1000))}</span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Убрать из очереди: ${track.title}`}
          className="text-muted p-1 opacity-0 group-hover/q:opacity-100 hover:text-black focus:opacity-100 dark:hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
