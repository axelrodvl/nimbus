import { ViewTransition } from 'react';
import { Collapsible } from '@/components/ui/collapsible';
import { Cover } from '@/components/ui/cover';
import { Skeleton } from '@/components/ui/skeleton';
import { NowPlayingTrackTitle, TrackIndexCell, TrackPlayRow } from '@/features/track/components/track-interactions';
import { formatDuration } from '@/lib/utils';
import type { Track as TrackT } from '@/types/track';

type Props = {
  track: TrackT;
  index?: number;
  showAlbum?: boolean;
};

export function TrackRow({ track, index, showAlbum = true, queue }: Props & { queue?: TrackT[] }) {
  return (
    <TrackPlayRow track={track} queue={queue}>
      <div className="flex items-center gap-3 px-3 py-2">
        <TrackIndexCell trackId={track.id} index={index} />
        <Cover src={track.coverUrl} alt={track.title} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <NowPlayingTrackTitle trackId={track.id}>{track.title}</NowPlayingTrackTitle>
          <span className="text-muted truncate text-xs">
            {track.artist}
            {showAlbum && track.album ? ` · ${track.album}` : ''}
          </span>
        </div>
        {track.durationMs ? (
          <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.durationMs / 1000))}</span>
        ) : null}
      </div>
    </TrackPlayRow>
  );
}

export function TrackList({
  tracks,
  showIndex = false,
  collapseAfter,
  animateItems = false,
}: {
  tracks: TrackT[];
  showIndex?: boolean;
  collapseAfter?: number;
  animateItems?: boolean;
}) {
  const shouldCollapse = collapseAfter !== undefined && tracks.length > collapseAfter;
  const visible = shouldCollapse ? tracks.slice(0, collapseAfter) : tracks;
  const overflow = shouldCollapse ? tracks.slice(collapseAfter) : [];

  const row = (track: TrackT, index?: number) => {
    const item = <TrackRow key={track.id} track={track} index={index} queue={tracks} />;
    return animateItems ? <ViewTransition key={track.id}>{item}</ViewTransition> : item;
  };

  return (
    <>
      <div className="flex flex-col gap-0.5">{visible.map((track, i) => row(track, showIndex ? i : undefined))}</div>
      {overflow.length > 0 && (
        <Collapsible showMoreLabel={`Show ${overflow.length} more`}>
          {overflow.map((track, i) => row(track, showIndex ? visible.length + i : undefined))}
        </Collapsible>
      )}
    </>
  );
}

export function TrackRowSkeleton({ showIndex = false, index }: { showIndex?: boolean; index?: number }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {showIndex ? (
        <span className="text-muted w-5 text-right font-mono text-xs">{(index ?? 0) + 1}</span>
      ) : (
        <span className="w-5" />
      )}
      <Skeleton className="h-10 w-10 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-28 max-w-full" />
        <Skeleton className="h-3 w-20 max-w-full" />
      </div>
      <Skeleton className="h-3 w-8" />
    </div>
  );
}

export function TrackListSkeleton({
  count = 5,
  showIndex = false,
  showMore = false,
}: {
  count?: number;
  showIndex?: boolean;
  showMore?: boolean;
}) {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: count }).map((_, i) => (
          <TrackRowSkeleton key={i} showIndex={showIndex} index={i} />
        ))}
      </div>
      {showMore && <Skeleton className="skeleton-subtle mt-3 h-5 w-24" />}
    </>
  );
}
