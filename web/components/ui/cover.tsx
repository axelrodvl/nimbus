'use client';

import { Disc3 } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  src?: string | null;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  // Обложка в первом экране (LCP): грузить сразу, а не лениво.
  priority?: boolean;
  // Что показывать, если обложки нет или она не загрузилась (по умолчанию — градиент с иконкой диска).
  fallback?: React.ReactNode;
};

const sizeMap = {
  lg: 'h-24 w-24',
  md: 'h-12 w-12',
  sm: 'h-10 w-10',
};

// Обложка из Cover Art Archive. Домен редиректит на archive.org, поэтому `unoptimized`:
// браузер сам следует редиректам, а не наш сервер.
export function Cover({ src, alt, size = 'md', className, priority, fallback }: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-violet-500 to-purple-700',
        sizeMap[size],
        className,
      )}
    >
      {showImage ? (
        <Image
          src={src!}
          alt={alt}
          fill
          sizes={size === 'lg' ? '96px' : '56px'}
          unoptimized
          priority={priority}
          className="object-cover"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        (fallback ?? <Disc3 className="h-1/2 w-1/2 text-white/70" aria-hidden />)
      )}
    </div>
  );
}
