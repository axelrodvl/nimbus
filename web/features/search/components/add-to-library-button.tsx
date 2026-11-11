'use client';

import { Check, Plus } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { addToLibraryWithToast } from '@/features/search/add-to-library';
import { cn } from '@/lib/utils';

type Props = {
  type: 'artist' | 'album' | 'track';
  mbid: string;
  albumMbid?: string | null;
  className?: string;
  // Для палитры: кнопка не должна забирать фокус с поля ввода.
  tabIndex?: number;
};

export function AddToLibraryButton({ type, mbid, albumMbid, className, tabIndex }: Props) {
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
      const ok = await addToLibraryWithToast(input);
      if (ok) setAdded(true);
    });
  }

  const label = optimisticAdded ? 'Добавлено в библиотеку' : 'Добавить в библиотеку';
  return (
    <button
      type="button"
      onClick={handleClick}
      tabIndex={tabIndex}
      aria-label={label}
      title={label}
      disabled={pending}
      className={cn(
        'border-divider dark:border-divider-dark text-gray inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors',
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
    </button>
  );
}

// Метка для элементов, которые уже в библиотеке.
export function InLibraryBadge({ className }: { className?: string }) {
  return (
    <span
      title="В библиотеке"
      className={cn('text-accent inline-flex shrink-0 items-center gap-1 text-xs font-medium', className)}
    >
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only sm:not-sr-only">В библиотеке</span>
    </span>
  );
}
