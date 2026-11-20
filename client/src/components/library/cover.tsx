import { useState } from 'react';
import { MusicNote } from '@/components/ui/music-note';
import {
  coverSrc,
  imageLoading,
  isImageBroken,
  markImageBroken,
  markImageShown,
  type CoverThumb,
} from '@/lib/library/cover';
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
  const showImage = url !== null && failed !== url && !isImageBroken(url);
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
      {/* Подложка без `loading`: она всегда грузится сразу — её задача быть видимой раньше крупной. */}
      {showImage && small && small !== url ? (
        <img
          alt=""
          aria-hidden
          className="absolute inset-0 size-full object-cover"
          decoding={imageLoading(small).decoding}
          onLoad={() => markImageShown(small)}
          src={small}
        />
      ) : null}
      {showImage ? (
        <img
          alt={alt}
          className="absolute inset-0 size-full object-cover"
          fetchPriority={priority ? 'high' : undefined}
          {...imageLoading(url, priority)}
          onError={() => {
            markImageBroken(url);
            setFailed(url);
          }}
          onLoad={() => markImageShown(url)}
          src={url}
        />
      ) : (
        <MusicNote className="size-1/2 text-white/70" size={24} />
      )}
    </div>
  );
}
