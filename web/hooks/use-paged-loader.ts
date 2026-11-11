'use client';

import { useState, useTransition } from 'react';

type Page<T> = { items: T[]; next_cursor?: string | null };

// Подгрузка следующих страниц по `next_cursor` («Показать ещё»).
export function usePagedLoader<T>(initialCursor: string | null, load: (cursor: string) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function loadMore() {
    if (!cursor || pending) return;
    startTransition(async () => {
      try {
        const page = await load(cursor);
        setItems(prev => [...prev, ...page.items]);
        setCursor(page.next_cursor ?? null);
        setError(null);
      } catch {
        setError('Не удалось загрузить. Попробуйте ещё раз.');
      }
    });
  }

  return { error, hasMore: cursor !== null, items, loadMore, pending };
}
