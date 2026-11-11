'use client';

import { Pause, Play } from 'lucide-react';
import { isPlayable } from '@/features/library/components/track-status-badge';
import { toPlayerTrack } from '@/features/library/to-player-track';
import type { TrackDto } from '@/features/library/to-player-track';
import { useT } from '@/providers/i18n-provider';
import { useLiveLibrary } from '@/providers/live-library-provider';
import { usePlayer } from '@/providers/player-provider';

// «Слушать альбом»: очередь из играбельных (`found`/`ready`) треков альбома, с учётом live-статусов.
export function PlayAlbumButton({ tracks }: { tracks: TrackDto[] }) {
  const t = useT();
  const player = usePlayer();
  const { trackStatus } = useLiveLibrary();
  const playable = tracks.filter(t => isPlayable(trackStatus.get(t.id)?.status ?? t.status));
  const albumIds = new Set(playable.map(t => t.id));
  const inThisAlbum = player.track ? albumIds.has(player.track.id) : false;
  const isThisPlaying = inThisAlbum && player.isPlaying;

  function onClick() {
    if (isThisPlaying) player.pause();
    else if (inThisAlbum) player.resume();
    else if (playable.length > 0) {
      const queue = playable.map(toPlayerTrack);
      player.play(queue[0], queue);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={playable.length === 0}
      data-testid="play-album"
      title={playable.length === 0 ? t('play.none') : undefined}
      className="inline-flex h-9 items-center gap-2 rounded-full bg-[#4f6ef7] px-4 text-sm font-medium text-white transition-transform enabled:hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {isThisPlaying ? (
        <Pause className="h-4 w-4" fill="currentColor" />
      ) : (
        <Play className="h-4 w-4" fill="currentColor" />
      )}
      {isThisPlaying ? t('play.pause') : t('play.album')}
    </button>
  );
}
