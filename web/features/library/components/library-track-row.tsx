'use client';

import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { Cover } from '@/components/ui/cover';
import { Equalizer } from '@/components/ui/equalizer';
import { isPlayable, TrackStatusBadge } from '@/features/library/components/track-status-badge';
import { toPlayerTrack } from '@/features/library/to-player-track';
import type { TrackDto } from '@/features/library/to-player-track';
import { AddToLibraryButton } from '@/features/search/components/add-to-library-button';
import { cn, formatDuration } from '@/lib/utils';
import { useTrackStatus } from '@/providers/live-library-provider';
import { usePlayer } from '@/providers/player-provider';

type Props = {
  track: TrackDto;
  /** Треки, из которых формируется очередь воспроизведения. */
  queue: TrackDto[];
  showAlbum?: boolean;
  /** Номер вместо обложки (страница альбома). */
  index?: number;
  /** MBID release group альбома — нужен для кнопки «+» у треков вне библиотеки. */
  albumMbid?: string;
};

// Строка трека библиотеки: статус, воспроизведение (только `found`/`ready`), «+» для треков вне библиотеки.
export function LibraryTrackRow({ track, queue, showAlbum = true, index, albumMbid }: Props) {
  const player = usePlayer();
  const live = useTrackStatus(track.id, track.status, track.status_reason ?? null);
  const playable = isPlayable(live.status);
  const isCurrent = player.track?.id === track.id;
  const isThisPlaying = player.isPlaying && isCurrent;

  function toggle() {
    if (!playable) return;
    if (isThisPlaying) player.pause();
    else if (isCurrent) player.resume();
    else
      player.play(
        toPlayerTrack(track),
        queue.filter(q => isPlayable(q.status) || q.id === track.id).map(toPlayerTrack),
      );
  }

  return (
    <div
      data-testid="track-row"
      data-track-id={track.id}
      className={cn(
        'group/track flex items-center gap-3 rounded-md px-3 py-2 transition-colors',
        isCurrent ? 'bg-card/40 dark:bg-card-dark/40' : 'hover:bg-card/60 dark:hover:bg-card-dark/60',
        !track.in_library && 'opacity-55',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={!playable}
        aria-label={isThisPlaying ? `Пауза: ${track.title}` : `Играть: ${track.title}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-black enabled:hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-30 dark:text-white dark:enabled:hover:bg-white/10"
      >
        {isThisPlaying ? (
          <Equalizer size="sm" />
        ) : index !== undefined && !playable ? (
          <span className="text-muted font-mono text-xs">{index}</span>
        ) : isCurrent ? (
          <Pause className="h-4 w-4" fill="currentColor" />
        ) : (
          <Play className="h-4 w-4" fill="currentColor" />
        )}
      </button>
      {index === undefined ? <Cover src={track.cover_url} alt={track.album_title} size="sm" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm font-medium', isCurrent && 'text-accent')}>{track.title}</span>
        <span className="text-muted truncate text-xs">
          <Link href={`/artist/${track.artist_id}`} className="hover:underline">
            {track.artist_name}
          </Link>
          {showAlbum ? (
            <>
              {' · '}
              <Link href={`/album/${track.album_id}`} className="hover:underline">
                {track.album_title}
              </Link>
            </>
          ) : null}
        </span>
      </div>
      {track.duration_ms ? (
        <span className="text-muted hidden font-mono text-xs sm:block">
          {formatDuration(Math.floor(track.duration_ms / 1000))}
        </span>
      ) : null}
      {track.in_library ? (
        <TrackStatusBadge
          trackId={track.id}
          albumId={track.album_id}
          status={track.status}
          reason={track.status_reason ?? null}
        />
      ) : albumMbid ? (
        <AddToLibraryButton type="track" mbid={track.mbid_recording} albumMbid={albumMbid} className="h-7 w-7" />
      ) : null}
    </div>
  );
}
