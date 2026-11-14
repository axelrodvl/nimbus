import { Link } from 'react-router';
import { AlbumOfflineBadge } from '@/components/offline/album-badge';
import { useAlbumDimmed } from '@/lib/offline/hooks';
import { useT } from '@/lib/i18n/provider';
import { albumMeta } from '@/lib/library/status';
import type { AlbumView } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';
import { Cover } from './cover';
import { StatusMiniBar } from './status-mini-bar';

/** Высота карточки сверх ширины ячейки (отступы, зазоры, блок текста, полоска): нужна виртуальной сетке. */
export const ALBUM_CARD_EXTRA = 124;

type Props = {
  album: AlbumView;
  /** Обложка над сгибом — грузится сразу. */
  priority?: boolean;
  /** Слот под действия (кнопка воспроизведения): накладывается на правый нижний угол обложки. */
  actions?: React.ReactNode;
};

/** Карточка альбома. Высота текстового блока фиксирована — строки виртуальной сетки не «прыгают». */
export function AlbumCard({ album, priority, actions }: Props) {
  const t = useT();
  const dimmed = useAlbumDimmed(album.id);
  return (
    <div className="group/card relative h-full" data-testid="album-card">
      <Link
        className={cn(
          'bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark focus-visible:ring-accent/40 flex h-full flex-col gap-3 rounded-lg p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none',
          !album.in_library && 'opacity-80',
          dimmed && 'opacity-55',
        )}
        data-dimmed={dimmed || undefined}
        to={`/album/${album.id}`}
      >
        <Cover alt={album.title} className="w-full shadow-lg" priority={priority} src={album.cover_url} />
        <div className="flex h-24 min-w-0 flex-col gap-0.5 overflow-hidden">
          <span className="line-clamp-2 text-sm font-semibold">{album.title}</span>
          <span className="text-muted line-clamp-2 text-xs">{albumMeta(album)}</span>
          {!album.in_library ? <span className="text-muted text-xs italic">{t('album.onlySingles')}</span> : null}
        </div>
        <div className="h-1">
          <StatusMiniBar counts={album.statusCounts} total={album.trackCount} />
        </div>
      </Link>
      <AlbumOfflineBadge albumId={album.id} />
      {actions ? (
        <div className="absolute right-5 bottom-[7.5rem] opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
