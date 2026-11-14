import { Link } from 'react-router';
import { Marquee } from '@/components/ui/marquee';
import type { PlayerTrack } from '@/lib/player';

/** Название (бегущая строка, ссылка на альбом) и исполнитель · альбом. Без трека — подсказка. */
export function TrackInfo({
  track,
  placeholder,
  title,
  withAlbum,
}: {
  track: PlayerTrack | null;
  placeholder?: string;
  title: string;
  withAlbum?: boolean;
}) {
  const titleEl =
    track?.albumId !== undefined ? (
      <Marquee>
        <Link className="hover:underline" to={`/album/${track.albumId}`}>
          {title}
        </Link>
      </Marquee>
    ) : (
      <Marquee>{title}</Marquee>
    );
  return (
    <div className="flex min-w-0 flex-col" data-testid="player-track">
      <span className="flex min-w-0 text-sm font-medium text-black dark:text-white">{titleEl}</span>
      <span className="text-muted truncate text-xs">
        {placeholder ??
          (track ? (
            <>
              {track.artistId !== undefined ? (
                <Link className="hover:underline" to={`/artist/${track.artistId}`}>
                  {track.artist}
                </Link>
              ) : (
                track.artist
              )}
              {withAlbum && track.album ? ` · ${track.album}` : ''}
            </>
          ) : null)}
      </span>
    </div>
  );
}
