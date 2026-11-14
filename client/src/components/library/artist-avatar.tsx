import { useState } from 'react';
import { artistImageUrl } from '@/lib/platform/urls';
import { cn } from '@/lib/utils';

// Фото ищет бэкенд (`/api/artist-image/{mbid}`: Wikidata/Commons, затем Deezer).
// Запасной вариант — инициалы на градиенте, цвет детерминирован от mbid.
function hue(mbid: string) {
  let h = 0;
  for (const ch of mbid.replace(/-/g, '').slice(0, 8)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?'];
  return letters.map(w => Array.from(w ?? '')[0]?.toUpperCase() ?? '').join('');
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
      <img
        alt=""
        className="absolute inset-0 size-full rounded-full object-cover"
        decoding="async"
        loading="lazy"
        onError={() => setFailed(true)}
        src={artistImageUrl(mbid)}
      />
    </span>
  );
}
