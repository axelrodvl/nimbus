import { Check, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import type { AddInput } from '@/lib/api/search';
import { addToLibrary, finishAdding, useIsAdding } from '@/lib/search/add';
import { addToHistory } from '@/lib/search/history';
import { cn } from '@/lib/utils';

type Props = {
  input: AddInput;
  /** Куда ведёт сущность, если она уже в библиотеке (по `mbid` из store); иначе `null`. */
  libraryHref: string | null;
  /** Запрос, из которого добавляют, — попадёт в историю. */
  query?: string;
  /** Для палитры: кнопка не забирает фокус с поля ввода. */
  tabIndex?: number;
  className?: string;
  onNavigate?: () => void;
};

/** «Уже в библиотеке» — отметка и ссылка «Открыть». */
export function InLibrary({ href, query, onNavigate }: { href: string; query?: string; onNavigate?: () => void }) {
  const t = useT();
  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-testid="in-library">
      <span className="text-accent inline-flex items-center gap-1 text-xs font-medium">
        <Check aria-hidden className="size-4" />
        {t('add.inLibrary')}
      </span>
      <Link
        className="text-accent focus-visible:ring-accent/40 rounded text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => {
          if (query) addToHistory(query);
          onNavigate?.();
        }}
        tabIndex={-1}
        to={href}
      >
        {t('search.open')}
      </Link>
    </span>
  );
}

/**
 * Добавить в библиотеку: «добавить» → «добавляется» (пока дельта не принесёт сущность) → «в библиотеке» + ссылка.
 * Состояние «добавляется» хранится по `mbid` вне компонента и переживает размонтирование.
 */
export function AddToLibraryButton({ input, libraryHref, query, tabIndex, className, onNavigate }: Props) {
  const t = useT();
  const adding = useIsAdding(input.mbid);
  const mbid = input.mbid;
  // Сущность появилась в store — «добавляется» закончилось.
  useEffect(() => {
    if (libraryHref !== null) finishAdding(mbid);
  }, [libraryHref, mbid]);

  if (libraryHref !== null) return <InLibrary href={libraryHref} onNavigate={onNavigate} query={query} />;
  return (
    <button
      aria-busy={adding || undefined}
      aria-label={adding ? t('add.adding') : t('add.toLibrary')}
      className={cn(
        'border-divider dark:border-divider-dark text-gray focus-visible:ring-accent/40 inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors hover:border-black hover:text-black focus-visible:ring-2 focus-visible:outline-none disabled:cursor-wait dark:hover:border-white dark:hover:text-white',
        adding && 'border-accent text-accent',
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
