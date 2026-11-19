import { useState } from 'react';
import { imageLoading, markImageShown } from '@/lib/library/cover';
import { artistImageUrl } from '@/lib/platform/urls';
import { useArtistImage } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

// Фото ищет бэкенд (`/api/artist-image/{mbid}`: Wikidata/Commons, затем Deezer) и сообщает признак в синхронизации
// (`artist.image`): `'no'` — инициалы сразу, без запроса и без задержки; `'yes'` и «не искали» (`null`/нет в store) —
// запрос. Запасной вариант — инициалы на градиенте, цвет детерминирован от mbid.
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

export function ArtistAvatar({
  mbid,
  name,
  className,
  image,
}: {
  mbid: string;
  name: string;
  className?: string;
  /** Признак фото, если он уже известен вызывающему; иначе берётся из store по `mbid`. */
  image?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const known = useArtistImage(mbid);
  const hasPhoto = (image === undefined ? known : image) !== 'no';
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
  // Фото точно нет: инициалы в первом кадре, `<img>` не рендерится, запроса нет.
  if (failed || !hasPhoto) return fallback;
  const src = artistImageUrl(mbid);
  // Под фото — инициалы, но проявляются они с задержкой (`delayed-appear`): фото из кэша (его уже показывал поиск или
  // список) успевает раньше, и вместо вспышки «инициалы → фото» сразу фото.
  return (
    <span className={cn('bg-card dark:bg-card-dark relative block shrink-0 overflow-hidden rounded-full', size)}>
      <span className="delayed-appear absolute inset-0">{fallback}</span>
      <img
        alt=""
        className="absolute inset-0 size-full rounded-full object-cover"
        {...imageLoading(src)}
        onError={() => setFailed(true)}
        onLoad={() => markImageShown(src)}
        src={src}
      />
    </span>
  );
}
