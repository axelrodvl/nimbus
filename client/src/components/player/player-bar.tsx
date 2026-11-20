import { ListMusic } from 'lucide-react';
import { Cover } from '@/components/library/cover';
import { useIsWideWidth } from '@/components/ui/use-media-query';
import { useT } from '@/lib/i18n/provider';
import { usePlayerState } from '@/lib/player/hooks';
import { currentTrack } from '@/lib/player/engine';
import { DownloadInfo } from './download-info';
import { ProgressRow } from './progress-row';
import { TrackInfo } from './track-info';
import { TrackMenu } from './track-menu';
import { ToggleButton, Transport } from './transport';
import { Volume } from './volume';

/** Настольная панель плеера (от `sm`): трек, управление, полоса прогресса, очередь и громкость. Видна всегда. */
export function PlayerBar({
  queueOpen,
  onToggleQueue,
  onOpenFull,
}: {
  queueOpen: boolean;
  onToggleQueue: () => void;
  onOpenFull: () => void;
}) {
  const wide = useIsWideWidth();
  const t = useT();
  const track = usePlayerState(currentTrack);
  return (
    <div
      className="border-divider dark:border-divider-dark hidden shrink-0 border-t bg-white px-4 py-2 sm:block dark:bg-[#181818]"
      data-testid="player-bar"
      style={{ viewTransitionName: 'player-bar-desktop' }}
    >
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_2fr] items-center gap-4 lg:grid-cols-[minmax(0,1fr)_2fr_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="hidden items-center gap-3 lg:flex">
            <button
              aria-label={t('player.expand')}
              className="focus-visible:ring-accent/40 shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
              disabled={!track}
              onClick={onOpenFull}
              type="button"
            >
              <Cover alt={track?.title ?? ''} className="size-14 rounded-sm" src={track?.coverUrl} />
            </button>
            <TrackInfo
              placeholder={track ? undefined : t('player.pickTrack')}
              title={track?.title ?? t('player.nothing')}
              track={track}
              withAlbum
            />
          </div>
          {/* Планшет (sm…lg): обложка с названием открывает полноэкранный плеер, рядом — очередь. */}
          <div className="flex items-center gap-3 lg:hidden">
            <button
              aria-label={t('player.expand')}
              className="focus-visible:ring-accent/40 flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:ring-2 focus-visible:outline-none"
              disabled={!track}
              onClick={onOpenFull}
              type="button"
            >
              <Cover alt={track?.title ?? ''} className="size-10 shrink-0 rounded-sm" src={track?.coverUrl} />
              <TrackInfo title={track?.title ?? t('player.nothing')} track={track} />
            </button>
            <ToggleButton active={queueOpen} label={t('player.queue')} onClick={onToggleQueue}>
              <ListMusic className="size-4" />
            </ToggleButton>
          </div>
        </div>
        <div className="flex w-full flex-col items-center gap-1">
          <Transport />
          <ProgressRow disabled={!track} paused={!wide} testIds={{ elapsed: 'player-elapsed', seek: 'player-seek' }} />
          <DownloadInfo />
        </div>
        <div className="hidden items-center justify-end gap-2 lg:flex">
          {track ? <TrackMenu track={track} /> : null}
          <ToggleButton active={queueOpen} label={t('player.queue')} onClick={onToggleQueue} testId="player-queue">
            <ListMusic className="size-4" />
          </ToggleButton>
          <Volume />
        </div>
      </div>
    </div>
  );
}
