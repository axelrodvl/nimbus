import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import { usePendingAdds, type PendingAdd } from '@/lib/search/add';
import { useMbidIndex } from '@/lib/store/hooks';
import { ArtistAvatar } from './artist-avatar';
import { Cover } from './cover';

/**
 * Карточка добавляемого — рядом с карточками библиотеки, того же размера. Ссылки нет: локального id ещё нет;
 * когда дельта принесёт сущность, вместо заглушки появится настоящая карточка.
 */
export function PendingAddCard({ item }: { item: PendingAdd }) {
  const t = useT();
  const { preview, type } = item;
  const title = preview?.title ?? '';
  const artist = type === 'artist';
  return (
    <div
      aria-busy
      className={`flex h-full flex-col gap-3 py-3 ${artist ? 'items-center text-center' : ''}`}
      data-testid="pending-add"
      data-type={type}
    >
      {artist ? (
        <ArtistAvatar className="h-28 w-28 text-3xl" mbid={item.mbid} name={title} />
      ) : (
        <Cover alt={title} className="w-full opacity-70 shadow-lg" src={preview?.cover} />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm font-semibold">{title}</span>
        {artist ? null : (
          <span className="text-muted line-clamp-1 text-xs">
            {[t(`kind.${type}`), preview?.artistName].filter(Boolean).join(' · ')}
          </span>
        )}
        <span className="text-accent-fg inline-flex items-center gap-1.5 text-xs font-medium">
          <Spinner className="size-3.5" />
          {t('add.adding')}
        </span>
      </div>
    </div>
  );
}

/** Добавляемые сущности, которых ещё нет в store; `type` — только один вид. */
export function usePending(type?: PendingAdd['type']): PendingAdd[] {
  return usePendingAdds(useMbidIndex(), type);
}

/** Полоса добавляемого над списком библиотеки: видно сразу после нажатия «Добавить». */
export function PendingStrip({ type }: { type: PendingAdd['type'] }) {
  const pending = usePending(type);
  return pending.length ? (
    <ul
      className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      data-testid="pending-strip"
    >
      {pending.map(p => (
        <li key={p.mbid}>
          <PendingAddCard item={p} />
        </li>
      ))}
    </ul>
  ) : null;
}
