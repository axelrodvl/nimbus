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
 * Нет адреса или картинка не загрузилась — заглушка с нотой на градиенте. Пока картинка грузится — нейтральный фон,
 * а под крупной миниатюрой ещё и малая (обычно уже в кэше: её показывали карточка или строка, с которой открыли
 * экран), — без вспышки «градиент → обложка».
 */
export function Cover({ src, alt, thumb = 250, priority, className }: Props) {
  const url = coverSrc(src, thumb);
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url !== null && failed !== url;
  const small = thumb === 250 ? null : coverSrc(src, 250);
  return (
    <div
      className={cn(
        'relative flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-md',
        showImage ? 'bg-card dark:bg-card-dark' : 'bg-gradient-to-br from-violet-500 to-purple-700',
        className,
      )}
      data-testid="cover"
    >
      {showImage && small && small !== url ? (
        <img alt="" aria-hidden className="absolute inset-0 size-full object-cover" decoding="async" src={small} />
      ) : null}
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
