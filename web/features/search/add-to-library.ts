'use client';

import { toast } from 'sonner';
import { addToLibrary } from '@/app/actions/library';
import type { AddToLibraryInput } from '@/app/actions/library';
import { clearSearchCache } from '@/hooks/use-search';

// Добавляет в библиотеку и показывает toast с итогом. Возвращает true, если элемент теперь в библиотеке.
export async function addToLibraryWithToast(input: AddToLibraryInput): Promise<boolean> {
  const result = await addToLibrary(input);
  if (!result.ok) {
    toast.error(result.message, { id: 'add-to-library' });
    return false;
  }
  // Результаты поиска теперь устарели: «В библиотеке» должно появиться при повторном запросе.
  clearSearchCache();
  if (result.status === 'exists') toast('Уже в библиотеке', { id: 'add-to-library' });
  else if (result.type === 'artist') toast('Импортируем дискографию…', { id: 'add-to-library' });
  else toast.success('Добавлено в библиотеку', { id: 'add-to-library' });
  return true;
}
