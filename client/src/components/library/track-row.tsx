import { AlertTriangle, Headphones } from 'lucide-react';
import { Link } from 'react-router';
import { TrackOfflineIndicator } from '@/components/offline/track-offline';
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
  /** Слот перед названием (кнопка воспроизведения). */
  leading?: React.ReactNode;
  /** Слот справа (меню трека, кнопки скачивания — шаги 42–47). */
  actions?: React.ReactNode;
  /** Трек сейчас в плеере: строка подсвечена, название акцентным цветом. */
  current?: boolean;
  /** Трек нельзя воспроизвести сейчас: строка приглушена. */
  unavailable?: boolean;
  /** Бейдж «требует подтверждения» — кнопка, открывающая выбор источника. */
  onCheckSource?: () => void;
  /** Действие по двойному клику и Enter на строке (запуск воспроизведения). */
  onActivate?: () => void;
};

/** Строка трека. Все данные — пропсами; фиксированная высота — для виртуализации. */
export function TrackRow({
  track,
  progress,
  showAlbum = true,
  index,
  leading,
  actions,
  current,
  unavailable,
  onActivate,
  onCheckSource,
}: Props) {
  const t = useT();
  return (
    <div
      className={cn(
        'focus-visible:ring-accent/40 flex h-[3.25rem] items-center gap-3 rounded-md px-3 transition-colors select-none focus-visible:ring-2 focus-visible:outline-none',
        current ? 'bg-card/40 dark:bg-card-dark/40' : 'hover:bg-card/60 dark:hover:bg-card-dark/60',
        (!track.in_library || unavailable) && 'opacity-55',
      )}
      data-current={current || undefined}
      data-testid="track-row"
      data-track-id={track.id}
      onDoubleClick={onActivate}
      onKeyDown={
        onActivate
          ? e => {
              if (e.key === 'Enter' && e.target === e.currentTarget) onActivate();
            }
          : undefined
      }
      tabIndex={onActivate ? 0 : undefined}
    >
      {leading}
      {index !== undefined ? (
        <span className="text-muted w-6 shrink-0 text-center font-mono text-xs">{index}</span>
      ) : (
        <Cover alt={track.albumTitle} className="size-10" src={track.coverUrl} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm font-medium', current && 'text-accent-fg')}>{track.title}</span>
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
        onCheckSource ? (
          <button
            aria-label={t('row.checkSource')}
            className="focus-visible:ring-accent/40 rounded-full p-0.5 focus-visible:ring-2 focus-visible:outline-none"
            data-testid="needs-confirmation"
            onClick={e => {
              e.stopPropagation();
              onCheckSource();
            }}
            title={t('row.checkSourceTitle')}
            type="button"
          >
            <AlertTriangle aria-hidden className="text-warning-fg size-4" />
          </button>
        ) : (
          <span
            aria-label={t('row.checkSource')}
            data-testid="needs-confirmation"
            role="img"
            title={t('row.checkSourceTitle')}
          >
            <AlertTriangle aria-hidden className="text-warning-fg size-4" />
          </span>
        )
      ) : null}
      <TrackOfflineIndicator trackId={track.id} />
      {track.in_library ? (
        <TrackStatusBadge progress={progress} reason={track.status_reason ?? null} status={track.status} />
      ) : null}
      {actions}
    </div>
  );
}
