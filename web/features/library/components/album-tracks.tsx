'use client';

import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import type { TrackDto } from '@/features/library/to-player-track';
import { useT } from '@/providers/i18n-provider';

// Треки альбома по дискам. Не входящие в библиотеку приглушены и имеют кнопку «+».
export function AlbumTracks({ tracks, albumMbid }: { tracks: TrackDto[]; albumMbid: string }) {
  const t = useT();
  const multiDisc = new Set(tracks.map(t => t.disc_no)).size > 1;
  return (
    <ol data-testid="album-tracks" className="flex flex-col gap-0.5">
      {tracks.map((tr, i) => {
        const header = multiDisc && tr.disc_no !== tracks[i - 1]?.disc_no;
        return (
          <li key={tr.id}>
            {header ? (
              <p className="text-muted px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">{t('album.disc', { n: tr.disc_no })}</p>
            ) : null}
            <LibraryTrackRow track={tr} queue={tracks} showAlbum={false} index={tr.position} albumMbid={albumMbid} />
          </li>
        );
      })}
    </ol>
  );
}
