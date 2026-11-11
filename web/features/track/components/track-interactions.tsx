'use client';

import { Play } from 'lucide-react';
import { Equalizer } from '@/components/ui/equalizer';
import { cn } from '@/lib/utils';
import { usePlayer } from '@/providers/player-provider';
import type { Track } from '@/types/track';

export function TrackPlayRow({ track, queue, children }: { track: Track; queue?: Track[]; children: React.ReactNode }) {
  const player = usePlayer();
  const isThisPlaying = player.isPlaying && player.track?.id === track.id;
  const isThisTrack = player.track?.id === track.id;

  function handleClick() {
    if (isThisPlaying) {
      player.pause();
    } else if (player.track?.id === track.id) {
      player.resume();
    } else {
      player.play(track, queue);
    }
  }

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-label={isThisPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
      className={cn(
        'group/track cursor-pointer rounded-md transition-colors',
        isThisTrack ? 'bg-card/40 dark:bg-card-dark/40' : 'hover:bg-card/60 dark:hover:bg-card-dark/60',
      )}
    >
      {children}
    </article>
  );
}

export function NowPlayingTrackTitle({
  trackId,
  children,
  className,
}: {
  trackId: number;
  children: React.ReactNode;
  className?: string;
}) {
  const player = usePlayer();
  const isThisTrack = player.track?.id === trackId;
  return (
    <span
      className={cn(
        'truncate text-sm font-semibold',
        isThisTrack ? 'text-accent' : (className ?? 'text-black dark:text-white'),
      )}
    >
      {children}
    </span>
  );
}

export function TrackIndexCell({ trackId, index }: { trackId: number; index?: number }) {
  const player = usePlayer();
  const isPlaying = player.isPlaying && player.track?.id === trackId;
  const isCurrent = player.track?.id === trackId;

  if (isPlaying) {
    return (
      <span className="flex w-5 items-center justify-center">
        <Equalizer size="sm" />
      </span>
    );
  }

  if (isCurrent) {
    return (
      <span className="text-accent flex w-5 justify-center text-xs font-bold">
        {index !== undefined ? index + 1 : '•'}
      </span>
    );
  }

  return (
    <span className="w-5 text-right">
      {index !== undefined ? (
        <>
          <span className="text-muted font-mono text-xs group-hover/track:hidden [@media(hover:none)]:hidden">
            {index + 1}
          </span>
          <Play
            className="hidden h-3.5 w-3.5 text-black group-hover/track:inline dark:text-white [@media(hover:none)]:inline"
            fill="currentColor"
          />
        </>
      ) : (
        <Play
          className="hidden h-3.5 w-3.5 text-black group-hover/track:inline dark:text-white [@media(hover:none)]:inline"
          fill="currentColor"
        />
      )}
    </span>
  );
}
