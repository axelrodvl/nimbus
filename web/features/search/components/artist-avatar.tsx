'use client';

import { useState } from 'react';
import { publicBackendUrl } from '@/lib/env';
import { cn } from '@/lib/utils';

// Фото ищет бэкенд (`/api/artist-image/{mbid}`: Wikidata/Commons, затем Deezer).
// Fallback — инициалы на градиенте, цвет детерминирован от mbid.
function hue(mbid: string) {
  let h = 0;
  for (const ch of mbid.replace(/-/g, '').slice(0, 8)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?'];
  return letters.map(w => Array.from(w)[0]?.toUpperCase() ?? '').join('');
}

export function ArtistAvatar({ mbid, name, className }: { mbid: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const h = hue(mbid);
  const size = className ?? 'h-24 w-24 text-2xl';
  const fallback = (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-bold text-white select-none', size)}
      style={{ background: `linear-gradient(135deg, hsl(${h} 65% 50%), hsl(${(h + 45) % 360} 65% 32%))` }}
    >
      {initials(name)}
    </span>
  );
  if (failed) return fallback;
  return (
    <span className={cn('relative block shrink-0 overflow-hidden rounded-full', size)}>
      <span className="absolute inset-0">{fallback}</span>
      {/* eslint-disable-next-line @next/next/no-img-element -- редирект на внешний CDN, оптимизатор не нужен */}
      <img
        src={`${publicBackendUrl}/api/artist-image/${mbid}`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full rounded-full object-cover"
      />
    </span>
  );
}
