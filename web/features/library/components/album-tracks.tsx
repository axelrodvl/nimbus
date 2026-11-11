'use client';

import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import type { TrackDto } from '@/features/library/to-player-track';

// Треки альбома по дискам. Не входящие в библиотеку приглушены и имеют кнопку «+».
export function AlbumTracks({ tracks, albumMbid }: { tracks: TrackDto[]; albumMbid: string }) {
  const multiDisc = new Set(tracks.map(t => t.disc_no)).size > 1;
  return (
    <ol data-testid="album-tracks" className="flex flex-col gap-0.5">
      {tracks.map((t, i) => {
        const header = multiDisc && t.disc_no !== tracks[i - 1]?.disc_no;
        return (
          <li key={t.id}>
            {header ? (
              <p className="text-muted px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">Диск {t.disc_no}</p>
            ) : null}
            <LibraryTrackRow track={t} queue={tracks} showAlbum={false} index={t.position} albumMbid={albumMbid} />
          </li>
        );
      })}
    </ol>
  );
}
