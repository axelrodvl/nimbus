import { Check, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import { addToLibrary, finishAdding, useIsAdding, type AddRequest } from '@/lib/search/add';
import { cn } from '@/lib/utils';

type Props = {
  input: AddRequest;
  /** Куда ведёт сущность, если она уже в библиотеке (по `mbid` из store); иначе `null`. */
  libraryHref: string | null;
  /** Запрос, из которого добавляют, — попадёт в историю. */
  query?: string;
  /** Для палитры: кнопка не забирает фокус с поля ввода. */
  tabIndex?: number;
  className?: string;
};

/** «Уже в библиотеке» — только отметка. */
export function InLibrary() {
  const t = useT();
  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-testid="in-library">
      <span className="text-accent-fg inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap">
        <Check aria-hidden className="size-4" />
        {t('add.inLibrary')}
      </span>
    </span>
  );
}

/**
 * Добавить в библиотеку: «добавить» → «добавляется» (пока дельта не принесёт сущность) → «в библиотеке» + ссылка.
 * Состояние «добавляется» хранится по `mbid` вне компонента и переживает размонтирование.
 */
export function AddToLibraryButton({ input, libraryHref, query, tabIndex, className }: Props) {
  const t = useT();
  const adding = useIsAdding(input.mbid);
  const mbid = input.mbid;
  // Сущность появилась в store — «добавляется» закончилось.
  useEffect(() => {
    if (libraryHref !== null) finishAdding(mbid);
  }, [libraryHref, mbid]);

  if (libraryHref !== null) return <InLibrary />;
  return (
    <button
      aria-busy={adding || undefined}
      aria-label={adding ? t('add.adding') : t('add.toLibrary')}
      className={cn(
        'focus-visible:ring-accent/40 inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-wait',
        adding
          ? 'border-accent text-accent-fg border'
          : 'bg-accent hover:bg-accent-hover text-white shadow-sm active:scale-95',
        className,
      )}
      disabled={adding}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        void addToLibrary(input, t, query);
      }}
      tabIndex={tabIndex}
      title={adding ? t('add.adding') : t('add.toLibrary')}
      type="button"
    >
      {adding ? <Spinner className="size-4" /> : <Plus aria-hidden className="size-4" />}
      <span>{adding ? t('add.adding') : t('add.addShort')}</span>
    </button>
  );
}
