import { useState } from 'react';
import { MusicNote } from '@/components/ui/music-note';
import { coverSrc, type CoverThumb } from '@/lib/library/cover';
import { cn } from '@/lib/utils';

type Props = {
  src?: string | null;
  alt: string;
  /** Размер миниатюры Cover Art Archive: 250 для карточек и строк, 500 для шапки альбома. */
  thumb?: CoverThumb;
  /** Обложка над сгибом: грузится сразу и с высоким приоритетом. */
  priority?: boolean;
  className?: string;
};

/**
 * Обложка с фиксированным соотношением сторон 1:1 — вёрстка не прыгает, пока картинка грузится.
 * Нет адреса или картинка не загрузилась — заглушка с нотой.
 */
export function Cover({ src, alt, thumb = 250, priority, className }: Props) {
  const url = coverSrc(src, thumb);
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url !== null && failed !== url;
  return (
    <div
      className={cn(
        'relative flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-violet-500 to-purple-700',
        className,
      )}
      data-testid="cover"
    >
      {showImage ? (
        <img
          alt={alt}
          className="absolute inset-0 size-full object-cover"
          decoding="async"
          fetchPriority={priority ? 'high' : undefined}
          loading={priority ? 'eager' : 'lazy'}
          onError={() => setFailed(url)}
          src={url}
        />
      ) : (
        <MusicNote className="size-1/2 text-white/70" size={24} />
      )}
    </div>
  );
}
