'use client';

import { Check, Plus } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';
import type { AddResult } from '@/app/actions/library';
import { Spinner } from '@/components/ui/spinner';
import { addToLibraryWithToast } from '@/features/search/add-to-library';
import { cn } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';

type Props = {
  type: 'artist' | 'album' | 'track';
  mbid: string;
  albumMbid?: string | null;
  /** Текстовая подпись (кнопка становится «таблеткой»). */
  label?: string;
  className?: string;
  // Для палитры: кнопка не должна забирать фокус с поля ввода.
  tabIndex?: number;
  onAdded?: (result: Extract<AddResult, { ok: true }>) => void;
};

export function AddToLibraryButton({ type, mbid, albumMbid, label: text, className, tabIndex, onAdded }: Props) {
  const t = useT();
  const [added, setAdded] = useState(false);
  const [optimisticAdded, setOptimisticAdded] = useOptimistic(added);
  const [pending, startTransition] = useTransition();

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (pending || optimisticAdded) return;
    startTransition(async () => {
      setOptimisticAdded(true);
      const input = type === 'track' ? { album_mbid: albumMbid ?? null, mbid, type } : ({ mbid, type } as const);
      const result = await addToLibraryWithToast(input, t);
      if (result?.ok) {
        setAdded(true);
        onAdded?.(result);
      }
    });
  }

  const label = optimisticAdded ? t('add.added') : (text ?? t('add.toLibrary'));
  return (
    <button
      type="button"
      onClick={handleClick}
      tabIndex={tabIndex}
      aria-label={label}
      title={label}
      disabled={pending}
      className={cn(
        'border-divider dark:border-divider-dark text-gray inline-flex h-8 shrink-0 items-center justify-center rounded-full border transition-colors',
        text ? 'px-3' : 'w-8',
        'hover:border-black hover:text-black disabled:cursor-wait dark:hover:border-white dark:hover:text-white',
        optimisticAdded && 'border-accent text-accent',
        className,
      )}
    >
      {pending ? (
        <Spinner className="h-4 w-4" />
      ) : optimisticAdded ? (
        <Check className="h-4 w-4" />
      ) : (
        <Plus className="h-4 w-4" />
      )}
      {text ? (
        <span className="px-0.5 text-sm font-semibold">{optimisticAdded ? t('add.addedShort') : text}</span>
      ) : null}
    </button>
  );
}

// Метка для элементов, которые уже в библиотеке.
export function InLibraryBadge({ className }: { className?: string }) {
  const t = useT();
  return (
    <span
      title={t('add.inLibrary')}
      className={cn('text-accent inline-flex shrink-0 items-center gap-1 text-xs font-medium', className)}
    >
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only sm:not-sr-only">{t('add.inLibrary')}</span>
    </span>
  );
}
