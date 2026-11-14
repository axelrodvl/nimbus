import { ChevronDown, ListMusic, Shuffle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { AudioQuality } from '@/components/library/audio-quality';
import { Cover } from '@/components/library/cover';
import { Marquee } from '@/components/ui/marquee';
import { useT } from '@/lib/i18n/provider';
import { currentTrack } from '@/lib/player/engine';
import { useHasNext, usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { useAudioInfo } from '@/lib/player/use-audio-info';
import { cn } from '@/lib/utils';
import { DownloadInfo } from './download-info';
import { ProgressRow } from './progress-row';
import { TrackMenu } from './track-menu';
import { isConnecting, PlayPauseButton, RepeatButton, SkipButton, ToggleButton } from './transport';

const CLOSE_DRAG_PX = 100;
const SWIPE_MIN_PX = 50;

/**
 * Полноэкранный плеер. Сворачивается: ручкой сверху, шевроном, свайпом вниз, Esc.
 * Горизонтальный свайп по обложке: влево — следующий трек, вправо — предыдущий.
 */
export function FullPlayer({
  open,
  onClose,
  onOpenQueue,
}: {
  open: boolean;
  onClose: () => void;
  onOpenQueue: () => void;
}) {
  const t = useT();
  const player = usePlayerActions();
  const track = usePlayerState(currentTrack);
  const hasNext = useHasNext();
  const { isPlaying, connecting, shuffle } = usePlayerState(
    useShallow(s => ({
      connecting: isConnecting(s.status),
      isPlaying: s.isPlaying,
      shuffle: s.shuffle,
    })),
  );
  const { info, stale } = useAudioInfo(open ? track?.id : undefined);
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);
  const dragRef = useRef(0);
  const coverStart = useRef<{ x: number; y: number } | null>(null);
  // Направление последней смены трека — от него зависит анимация текста.
  const [dir, setDir] = useState<'next' | 'prev'>('next');

  useEffect(() => {
    if (!open) return;
    // Chrome на Android иначе воспринимает свайп вниз как pull-to-refresh.
    const root = document.documentElement;
    const prev = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'none';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overscrollBehaviorY = prev;
    };
  }, [open, onClose]);

  const onTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null) return;
    dragRef.current = Math.max(0, e.touches[0].clientY - startY.current);
    setDragY(dragRef.current);
  };
  const onTouchEnd = () => {
    if (startY.current === null) return;
    startY.current = null;
    if (dragRef.current > CLOSE_DRAG_PX) onClose();
    dragRef.current = 0;
    setDragY(0);
  };

  const goNext = () => {
    setDir('next');
    player.next();
  };
  const goPrev = () => {
    setDir('prev');
    player.previous();
  };
  const onCoverTouchStart = (e: React.TouchEvent) => {
    coverStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onCoverTouchEnd = (e: React.TouchEvent) => {
    const s = coverStart.current;
    coverStart.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  const muted = 'text-black/70 dark:text-white/75';
  return (
    <div
      aria-hidden={!open}
      aria-label={t('player.expand')}
      aria-modal={open || undefined}
      className={cn(
        'fixed inset-0 z-50 flex touch-pan-x flex-col overflow-hidden overscroll-none bg-white text-black dark:bg-[#181818] dark:text-white',
        dragY === 0 && 'transition-transform duration-300 ease-out',
        !open && 'translate-y-full',
      )}
      data-testid="full-player"
      inert={!open}
      onTouchCancel={onTouchEnd}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      onTouchStart={onTouchStart}
      // Закрытый плеер — не диалог: иначе горячие клавиши («/» палитры) считали бы, что диалог открыт.
      role={open ? 'dialog' : undefined}
      style={open ? { transform: `translateY(${dragY}px)` } : undefined}
    >
      {track ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 scale-150 opacity-30 blur-3xl dark:opacity-40"
          style={track.coverUrl ? { backgroundImage: `url(${track.coverUrl})`, backgroundSize: 'cover' } : undefined}
        />
      ) : null}
      <div className="relative mx-auto flex h-full w-full max-w-md flex-col px-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <button
          aria-label={t('player.collapse')}
          className="group mx-auto flex h-8 w-24 items-center justify-center"
          data-testid="full-player-close"
          onClick={onClose}
          type="button"
        >
          <span className="h-1.5 w-10 rounded-full bg-black/25 transition-colors group-hover:bg-black/40 dark:bg-white/30 dark:group-hover:bg-white/50" />
        </button>

        <div
          className="flex min-h-0 flex-1 items-center justify-center py-4"
          data-testid="full-player-cover"
          onTouchCancel={() => (coverStart.current = null)}
          onTouchEnd={onCoverTouchEnd}
          onTouchStart={onCoverTouchStart}
        >
          <Cover
            alt={track?.title ?? ''}
            className={cn(
              'max-h-full w-full rounded-xl shadow-2xl transition-transform duration-300',
              isPlaying ? 'scale-100' : 'scale-90',
            )}
            src={track?.coverUrl}
            thumb={500}
          />
        </div>

        <AudioQuality className={muted} info={info} stale={stale} />

        <div className="flex items-center gap-3 pt-2">
          <div
            className={cn('flex min-w-0 flex-1 flex-col', dir === 'next' ? 'animate-track-next' : 'animate-track-prev')}
            key={track?.id}
          >
            <Marquee className="text-xl font-semibold" data-testid="full-player-title">
              {track?.albumId !== undefined ? (
                <Link className="hover:underline" onClick={onClose} to={`/album/${track.albumId}`}>
                  {track.title}
                </Link>
              ) : (
                track?.title
              )}
            </Marquee>
            <span className={cn('truncate text-lg', muted)}>
              {track?.artistId !== undefined ? (
                <Link className="hover:underline" onClick={onClose} to={`/artist/${track.artistId}`}>
                  {track.artist}
                </Link>
              ) : (
                track?.artist
              )}
            </span>
          </div>
        </div>

        <div className="pt-5">
          <ProgressRow layout="full" />
          <div className="mt-1 flex h-4 items-center justify-center">
            {open ? <DownloadInfo className="text-black/70! dark:text-white/75!" /> : null}
          </div>
        </div>

        <div className="flex items-center justify-between pt-4">
          <ToggleButton
            active={shuffle}
            className={shuffle ? undefined : muted}
            label={t('player.shuffle')}
            onClick={player.toggleShuffle}
          >
            <Shuffle className="size-5" />
          </ToggleButton>
          <SkipButton big direction="back" onClick={goPrev} />
          <PlayPauseButton
            big
            isPlaying={isPlaying}
            loading={connecting && isPlaying}
            onClick={player.togglePlayPause}
          />
          <SkipButton big direction="forward" disabled={!hasNext} onClick={goNext} />
          <RepeatButton size="size-5" />
        </div>

        {/* Раньше здесь был ползунок громкости; место сохранено ради прежних отступов. */}
        <div aria-hidden className="h-12 shrink-0" />

        <div className="flex items-center justify-between pt-6">
          <button
            aria-label={t('player.collapse')}
            className={cn('p-2 hover:text-black dark:hover:text-white', muted)}
            onClick={onClose}
            type="button"
          >
            <ChevronDown className="size-6" />
          </button>
          {track ? (
            <TrackMenu
              className={cn('p-2 hover:text-black dark:hover:text-white', muted)}
              iconClassName="size-6"
              onNavigate={onClose}
              track={track}
            />
          ) : null}
          <button
            aria-label={t('player.queue')}
            className={cn('p-2 hover:text-black dark:hover:text-white', muted)}
            onClick={onOpenQueue}
            type="button"
          >
            <ListMusic className="size-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
