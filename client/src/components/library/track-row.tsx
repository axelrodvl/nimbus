import { AlertTriangle, Headphones } from 'lucide-react';
import { Link } from 'react-router';
import { useT } from '@/lib/i18n/provider';
import type { AlbumProgressInfo } from '@/lib/library/status';
import type { TrackView } from '@/lib/store/selectors';
import { cn, formatDuration } from '@/lib/utils';
import { Cover } from './cover';
import { TrackStatusBadge } from './track-status-badge';

/** Высота строки трека с зазором (шаг виртуального списка). */
export const TRACK_ROW_HEIGHT = 56;

type Props = {
  track: TrackView;
  progress?: AlbumProgressInfo;
  showAlbum?: boolean;
  /** Номер вместо обложки (страница альбома). */
  index?: number;
  /** Слот перед названием (кнопка воспроизведения — шаг 41). */
  leading?: React.ReactNode;
  /** Слот справа (меню трека, кнопки скачивания — шаги 42–47). */
  actions?: React.ReactNode;
};

/** Строка трека. Все данные — пропсами; фиксированная высота — для виртуализации. */
export function TrackRow({ track, progress, showAlbum = true, index, leading, actions }: Props) {
  const t = useT();
  return (
    <div
      className={cn(
        'hover:bg-card/60 dark:hover:bg-card-dark/60 flex h-[3.25rem] items-center gap-3 rounded-md px-3 transition-colors',
        !track.in_library && 'opacity-55',
      )}
      data-testid="track-row"
      data-track-id={track.id}
    >
      {leading}
      {index !== undefined ? (
        <span className="text-muted w-6 shrink-0 text-center font-mono text-xs">{index}</span>
      ) : (
        <Cover alt={track.albumTitle} className="size-10" src={track.coverUrl} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{track.title}</span>
        <span className="text-muted truncate text-xs">
          <Link className="hover:underline" to={`/artist/${track.artist_id}`}>
            {track.artistName}
          </Link>
          {showAlbum ? (
            <>
              {' · '}
              <Link className="hover:underline" to={`/album/${track.album_id}`}>
                {track.albumTitle}
              </Link>
            </>
          ) : null}
        </span>
      </div>
      {track.play_count > 0 ? (
        <span
          className="text-muted hidden items-center gap-1 text-xs tabular-nums sm:flex"
          data-testid="play-count"
          title={t('count.plays', { count: track.play_count })}
        >
          <Headphones aria-hidden className="size-3" />
          {track.play_count}
        </span>
      ) : null}
      {track.duration_ms ? (
        <span className="text-muted hidden font-mono text-xs sm:block">
          {formatDuration(Math.floor(track.duration_ms / 1000))}
        </span>
      ) : null}
      {track.in_library && track.needs_confirmation ? (
        <span
          aria-label={t('row.checkSource')}
          data-testid="needs-confirmation"
          role="img"
          title={t('row.checkSourceTitle')}
        >
          <AlertTriangle aria-hidden className="text-warning size-4" />
        </span>
      ) : null}
      {track.in_library ? (
        <TrackStatusBadge progress={progress} reason={track.status_reason ?? null} status={track.status} />
      ) : null}
      {actions}
    </div>
  );
}
