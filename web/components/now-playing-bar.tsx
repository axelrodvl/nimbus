'use client';

import {
  ListMusic,
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { QueuePanel } from '@/components/queue-panel';
import { Cover } from '@/components/ui/cover';
import { cn, formatDuration } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';
import { useTrackStatus } from '@/providers/live-library-provider';
import { describeDownload, playerErrorText } from '@/providers/player/engine';
import { usePlayer } from '@/providers/player-provider';

export function NowPlayingBar() {
  const t = useT();
  const player = usePlayer();
  const { track, isPlaying, position, duration, buffered, volume, muted, hasNext, status, shuffle, repeat } = player;
  const [queueOpen, setQueueOpen] = useState(false);

  const effectiveVolume = muted ? 0 : volume;
  const VolumeIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 50 ? Volume1 : Volume2;
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat;
  const elapsed = Math.floor(position);
  const total = Math.floor(duration);
  const connecting = status === 'loading' || status === 'buffering';

  const transport = (
    <div className="flex items-center gap-4">
      <ToggleButton
        label={t('player.shuffle')}
        active={shuffle}
        onClick={player.toggleShuffle}
        className="hidden sm:inline-flex"
        testId="player-shuffle"
      >
        <Shuffle className="h-4 w-4" />
      </ToggleButton>
      <SkipButton direction="back" onClick={player.previous} disabled={!track} />
      <PlayPauseButton
        isPlaying={isPlaying}
        loading={connecting && isPlaying}
        onClick={player.togglePlayPause}
        disabled={!track}
      />
      <SkipButton direction="forward" onClick={player.next} disabled={!track || !hasNext} />
      <ToggleButton
        label={repeat === 'off' ? t('player.repeat.off') : repeat === 'all' ? t('player.repeat.all') : t('player.repeat.one')}
        active={repeat !== 'off'}
        onClick={player.cycleRepeat}
        className="hidden sm:inline-flex"
        testId="player-repeat"
      >
        <RepeatIcon className="h-4 w-4" />
      </ToggleButton>
    </div>
  );

  return (
    <>
      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
      {track ? (
        <div
          style={{ viewTransitionName: 'player-bar' }}
          className="border-divider dark:border-divider-dark shrink-0 border-t bg-white px-4 py-2 sm:hidden dark:bg-[#181818]"
        >
          <div className="flex items-center gap-3">
            <Cover src={track.coverUrl} alt={track.title} size="sm" className="!h-12 !w-12 !rounded-sm" />
            <div className="flex min-w-0 flex-1 flex-col">
              <TrackInfo title={track.title} artist={track.artist} artistId={track.artistId} />
            </div>
            <div className="flex items-center gap-3">
              <SkipButton direction="back" onClick={player.previous} />
              <PlayPauseButton
                isPlaying={isPlaying}
                loading={connecting && isPlaying}
                onClick={player.togglePlayPause}
              />
              <SkipButton direction="forward" onClick={player.next} disabled={!hasNext} />
              <button
                type="button"
                onClick={() => setQueueOpen(o => !o)}
                aria-label={t('player.queue')}
                className="text-muted p-1 hover:text-black dark:hover:text-white"
              >
                <ListMusic className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-muted w-8 text-right text-[10px]">{formatDuration(elapsed)}</span>
            <SliderBar value={position} max={duration} buffered={buffered} onChange={player.seekTo} label={t('player.seek')} />
            <span className="text-muted w-8 text-[10px]">{formatDuration(total)}</span>
          </div>
          <StatusLine className="mt-1" />
        </div>
      ) : null}

      <div
        style={{ viewTransitionName: 'player-bar-desktop' }}
        className="border-divider dark:border-divider-dark hidden shrink-0 border-t bg-white px-4 py-2 sm:block dark:bg-[#181818]"
      >
        <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_2fr] items-center gap-4 lg:grid-cols-[minmax(0,1fr)_2fr_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="hidden items-center gap-3 lg:flex">
              <Cover src={track?.coverUrl} alt={track?.title ?? ''} size="sm" className="!h-14 !w-14 !rounded-sm" />
              <TrackInfo
                title={track?.title ?? t('player.nothing')}
                artist={track?.artist}
                artistId={track?.artistId}
                albumTitle={track?.album}
                albumId={track?.albumId}
                placeholder={track ? undefined : t('player.pickTrack')}
              />
            </div>
            <div className="flex items-center gap-3 lg:hidden">
              <Cover src={track?.coverUrl} alt={track?.title ?? ''} size="sm" className="!h-10 !w-10 !rounded-sm" />
              <TrackInfo
                title={track?.title ?? t('player.nothing')}
                artist={track?.artist}
                artistId={track?.artistId}
                albumId={track?.albumId}
              />
            </div>
          </div>
          <div className="flex w-full flex-col items-center gap-1">
            {transport}
            <div className="flex w-full items-center gap-2">
              <span className="text-muted w-8 text-right text-[10px]" data-testid="player-elapsed">
                {formatDuration(elapsed)}
              </span>
              <SliderBar
                value={position}
                max={duration}
                buffered={buffered}
                onChange={player.seekTo}
                label={t('player.seek')}
                disabled={!track}
                testId="player-seek"
              />
              <span className="text-muted w-8 text-[10px]">{formatDuration(total)}</span>
            </div>
            <StatusLine />
          </div>
          <div className="hidden items-center justify-end gap-2 lg:flex">
            <ToggleButton
              label={t('player.queue')}
              active={queueOpen}
              onClick={() => setQueueOpen(o => !o)}
              testId="player-queue"
            >
              <ListMusic className="h-4 w-4" />
            </ToggleButton>
            <button
              type="button"
              onClick={player.toggleMute}
              className="text-muted transition-colors hover:text-black dark:hover:text-white"
              aria-label={effectiveVolume === 0 ? t('player.unmute') : t('player.mute')}
            >
              <VolumeIcon className="h-3.5 w-3.5" />
            </button>
            <SliderBar
              value={effectiveVolume}
              max={100}
              onChange={player.setVolume}
              className="w-20"
              label={t('player.volume')}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// Состояние под прогресс-баром: подключение к раздаче, загрузка, ошибка.
function StatusLine({ className }: { className?: string }) {
  const t = useT();
  const { track, status, error, download, peersHint, cancel } = useStatusInfo();
  if (!track) return null;
  const connecting = status === 'loading' || status === 'buffering';
  let text: string | null = null;
  if (status === 'error' && error) text = playerErrorText(t, error.code);
  else if (connecting && (!download || download.bytes_done === 0)) {
    text = peersHint > 0 ? t('player.connectingPeers', { peers: peersHint }) : t('player.connecting');
  } else if (download && download.bytes_done < download.bytes_total) text = describeDownload(download, t);
  if (!text) return null;
  return (
    <div
      data-testid="player-status"
      className={cn(
        'text-muted flex items-center justify-center gap-2 text-[11px]',
        status === 'error' && 'text-red-500',
        className,
      )}
    >
      <span>{text}</span>
      {connecting ? (
        <button
          type="button"
          onClick={cancel}
          aria-label={t('player.cancel')}
          className="inline-flex items-center hover:text-black dark:hover:text-white"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function useStatusInfo() {
  const p = usePlayer();
  // Если трек уже скачан, прогресс загрузки не показываем.
  const live = useTrackStatus(p.track?.id ?? -1, p.track?.status ?? 'adding', null);
  const ready = live.status === 'ready';
  return {
    cancel: p.cancel,
    download: ready ? undefined : p.download,
    error: p.error,
    peersHint: p.download?.peers ?? 0,
    status: p.status,
    track: p.track,
  };
}

function SliderBar({
  value,
  max,
  onChange,
  className,
  label,
  disabled,
  buffered,
  testId,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  className?: string;
  label: string;
  disabled?: boolean;
  buffered?: [number, number][];
  testId?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));
  return (
    <div className={cn('group/slider relative flex flex-1 items-center', className)}>
      <div className="bg-divider dark:bg-divider-dark relative h-0.5 w-full rounded-full transition-all group-hover/slider:h-1">
        {buffered?.map(([s, e], i) => (
          <div
            key={i}
            data-testid="player-buffered"
            className="absolute top-0 h-full rounded-full bg-black/20 dark:bg-white/25"
            style={{ left: `${(s / safeMax) * 100}%`, width: `${((e - s) / safeMax) * 100}%` }}
          />
        ))}
        <div
          className="group-hover/slider:bg-accent absolute top-0 left-0 h-full rounded-full bg-black/60 dark:bg-white/60"
          style={{ width: `${pct}%` }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={safeMax}
        step="any"
        value={Math.min(value, safeMax)}
        onChange={e => onChange(Number(e.target.value))}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        className={cn(
          'absolute inset-0 m-0 h-full w-full appearance-none border-0 bg-transparent p-0 opacity-0',
          disabled ? 'pointer-events-none' : 'cursor-pointer',
        )}
      />
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
  children,
  className,
  testId,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        'items-center justify-center p-1 transition-colors',
        active ? 'text-accent' : 'text-muted hover:text-black dark:hover:text-white',
        className,
      )}
    >
      {children}
    </button>
  );
}

function SkipButton({
  direction,
  onClick,
  disabled,
}: {
  direction: 'back' | 'forward';
  onClick: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const Icon = direction === 'back' ? SkipBack : SkipForward;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-muted p-1 transition-colors hover:text-black disabled:opacity-40 dark:hover:text-white"
      aria-label={direction === 'back' ? t('player.previous') : t('player.next')}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function PlayPauseButton({
  isPlaying,
  loading,
  onClick,
  disabled,
}: {
  isPlaying: boolean;
  loading?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="player-play-pause"
      data-playing={isPlaying || undefined}
      className="flex h-8 w-8 items-center justify-center rounded-full bg-black text-white transition-transform hover:scale-105 disabled:opacity-40 dark:bg-white dark:text-black"
      aria-label={isPlaying ? t('player.pause') : t('player.play')}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : isPlaying ? (
        <Pause className="h-4 w-4" fill="currentColor" />
      ) : (
        <Play className="h-4 w-4 translate-x-[1px]" fill="currentColor" />
      )}
    </button>
  );
}

function TrackInfo({
  title,
  artist,
  artistId,
  albumTitle,
  albumId,
  placeholder,
}: {
  title: string;
  artist?: string;
  artistId?: number;
  albumTitle?: string | null;
  albumId?: number;
  placeholder?: string;
}) {
  const titleEl =
    albumId !== undefined ? (
      <Link href={`/album/${albumId}`} className="truncate hover:underline">
        {title}
      </Link>
    ) : (
      <span className="truncate">{title}</span>
    );
  return (
    <div className="flex min-w-0 flex-col" data-testid="player-track">
      <span className="flex min-w-0 text-sm font-medium text-black dark:text-white">{titleEl}</span>
      <span className="text-muted truncate text-xs">
        {placeholder ??
          (artist ? (
            <>
              {artistId !== undefined ? (
                <Link href={`/artist/${artistId}`} className="hover:underline">
                  {artist}
                </Link>
              ) : (
                artist
              )}
              {albumTitle ? ` · ${albumTitle}` : ''}
            </>
          ) : null)}
      </span>
    </div>
  );
}
