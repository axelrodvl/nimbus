import { useAlbumProgress, useTrackView } from '@/lib/store/hooks';
import { TrackRow } from './track-row';

type Props = Omit<React.ComponentProps<typeof TrackRow>, 'track' | 'progress'> & { id: number };

/**
 * Строка трека, подписанная на свой трек и прогресс своего альбома: событие статуса одного трека
 * перерисовывает только его строку, а не весь список.
 */
export function TrackRowById({ id, ...rest }: Props) {
  const track = useTrackView(id);
  const progress = useAlbumProgress(track?.album_id ?? -1);
  if (!track) return null;
  return <TrackRow {...rest} progress={progress} track={track} />;
}
