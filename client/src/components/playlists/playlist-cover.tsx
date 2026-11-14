import { ListMusic, Star } from 'lucide-react';
import { Cover } from '@/components/library/cover';
import type { PlaylistCard } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';

/** Обложка плейлиста: обложка первого альбома с картинкой; нет — значок (звезда у «Избранного»). */
export function PlaylistCover({
  card,
  alt,
  className,
  priority,
  thumb,
}: {
  card: Pick<PlaylistCard, 'coverUrl' | 'kind'>;
  alt: string;
  className?: string;
  priority?: boolean;
  thumb?: 250 | 500;
}) {
  const Icon = card.kind === 'favorites' ? Star : ListMusic;
  return (
    <div className={cn('relative shrink-0', className)}>
      <Cover alt={alt} className="size-full" priority={priority} src={card.coverUrl} thumb={thumb} />
      {card.coverUrl ? null : (
        <Icon aria-hidden className="pointer-events-none absolute inset-0 m-auto size-1/3 text-white/80" />
      )}
    </div>
  );
}
