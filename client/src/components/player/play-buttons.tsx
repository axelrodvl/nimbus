import { Pause, Play } from 'lucide-react';
import { Equalizer } from '@/components/ui/equalizer';
import { TrackRowById } from '@/components/library/connected';
import type { TrackRow } from '@/components/library/track-row';
import { useT } from '@/lib/i18n/provider';
import { canPlay, toPlayerTrack } from '@/lib/player';
import { useIsCurrentTrack, useIsTrackPlaying, usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { playableQueue, queueFromIds } from '@/lib/player/queues';
import { currentTrack } from '@/lib/player/engine';
import { useAlbumTracks, useTrackView } from '@/lib/store/hooks';
import type { TrackView } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';

/** Запуск трека: играет — пауза, на паузе — продолжить, иначе — начать с него (очередь — переданный список). */
function useToggleTrack(id: number, queue: () => ReturnType<typeof queueFromIds>) {
  const player = usePlayerActions();
  const view = useTrackView(id);
  const isCurrent = useIsCurrentTrack(id);
  const isPlaying = useIsTrackPlaying(id);
  const playable = view ? canPlay(view) : false;
  const toggle = () => {
    if (!view || !playable) return;
    if (isPlaying) player.pause();
    else if (isCurrent) player.resume();
    else player.play(toPlayerTrack(view), queue());
  };
  return { isCurrent, isPlaying, playable, title: view?.title ?? '', toggle };
}

/** Кнопка воспроизведения в строке трека. Недоступный трек — заблокирована и приглушена. */
function PlayButton({
  title,
  isPlaying,
  playable,
  onToggle,
}: {
  title: string;
  isPlaying: boolean;
  playable: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      aria-label={isPlaying ? t('row.pause', { title }) : t('row.play', { title })}
      className={cn(
        'text-gray hover:text-accent focus-visible:ring-accent/40 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed',
        isPlaying && 'text-accent',
      )}
      data-playing={isPlaying || undefined}
      data-testid="play-track"
      disabled={!playable}
      onClick={e => {
        e.stopPropagation();
        onToggle();
      }}
      type="button"
    >
      {isPlaying ? <Equalizer size="sm" /> : <Play className="size-4" fill="currentColor" />}
    </button>
  );
}

/**
 * «Слушать»: очередь — доступные треки списка по порядку. Играет — пауза; на паузе (текущий трек из этого списка) —
 * продолжить. `icon` — круглая кнопка поверх обложки карточки.
 */
export function PlayTracksButton({
  tracks,
  label,
  variant = 'pill',
  testId,
}: {
  tracks: readonly TrackView[];
  label?: string;
  variant?: 'pill' | 'icon';
  testId?: string;
}) {
  const t = useT();
  const player = usePlayerActions();
  const playable = tracks.filter(canPlay);
  const inThisList = usePlayerState(s => {
    const cur = currentTrack(s);
    return cur ? playable.some(tr => tr.id === cur.id) : false;
  });
  const isThisPlaying = usePlayerState(s => s.isPlaying) && inThisList;

  const onClick = () => {
    if (isThisPlaying) player.pause();
    else if (inThisList) player.resume();
    else if (playable.length > 0) {
      const queue = playableQueue(playable);
      player.play(queue[0], queue);
    }
  };
  const Icon = isThisPlaying ? Pause : Play;
  const text = isThisPlaying ? t('play.pause') : (label ?? t('play.playlist'));
  if (variant === 'icon') {
    return (
      <button
        aria-label={text}
        className="bg-accent hover:bg-accent-hover focus-visible:ring-accent/40 flex size-10 items-center justify-center rounded-full text-white shadow-xl transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:outline-none disabled:hidden"
        data-playing={isThisPlaying || undefined}
        data-testid={testId ?? 'play-album-card'}
        disabled={playable.length === 0}
        onClick={onClick}
        type="button"
      >
        {isThisPlaying ? <Equalizer color="bg-white" size="md" /> : <Icon className="size-5" fill="currentColor" />}
      </button>
    );
  }
  return (
    <button
      className="bg-accent hover:bg-accent-hover focus-visible:ring-accent/40 inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium text-white transition-transform focus-visible:ring-2 focus-visible:outline-none enabled:hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40"
      data-playing={isThisPlaying || undefined}
      data-testid={testId ?? 'play-album'}
      disabled={playable.length === 0}
      onClick={onClick}
      title={playable.length === 0 ? t('play.none') : undefined}
      type="button"
    >
      <Icon className="size-4" fill="currentColor" />
      {text}
    </button>
  );
}

/** «Слушать альбом» (шапка альбома) или круглая кнопка на карточке альбома. */
export function PlayAlbumButton({ albumId, variant = 'pill' }: { albumId: number; variant?: 'pill' | 'icon' }) {
  const t = useT();
  return <PlayTracksButton label={t('play.album')} tracks={useAlbumTracks(albumId)} variant={variant} />;
}

type RowProps = Omit<
  React.ComponentProps<typeof TrackRow>,
  'track' | 'leading' | 'current' | 'unavailable' | 'onActivate'
> & {
  id: number;
  /** Треки списка: очередь строится из них (доступные, по порядку), старт — с этой строки. */
  queueIds: readonly number[];
};

/**
 * Строка трека, подписанная на свой трек и прогресс альбома, с запуском воспроизведения: кнопка в слоте `leading`,
 * двойной клик и Enter по строке, подсветка текущего трека, недоступные треки приглушены.
 */
export function PlayableTrackRow({ id, queueIds, ...rest }: RowProps) {
  const { isCurrent, isPlaying, playable, title, toggle } = useToggleTrack(id, () => queueFromIds(queueIds));
  return (
    <TrackRowById
      {...rest}
      current={isCurrent}
      id={id}
      leading={<PlayButton isPlaying={isPlaying} onToggle={toggle} playable={playable} title={title} />}
      onActivate={playable ? toggle : undefined}
      unavailable={!playable}
    />
  );
}
