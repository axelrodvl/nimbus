'use client';

import { toast } from 'sonner';
import { addToLibrary } from '@/app/actions/library';
import type { AddResult, AddToLibraryInput } from '@/app/actions/library';
import { clearSearchCache } from '@/hooks/use-search';
import type { TFn } from '@/providers/i18n-provider';

// Добавляет в библиотеку и показывает toast с итогом. Возвращает результат, если элемент теперь в библиотеке, иначе null.
export async function addToLibraryWithToast(input: AddToLibraryInput, t: TFn): Promise<AddResult | null> {
  const result = await addToLibrary(input);
  if (!result.ok) {
    toast.error(result.message, { id: 'add-to-library' });
    return null;
  }
  // Результаты поиска теперь устарели: «В библиотеке» должно появиться при повторном запросе.
  clearSearchCache();
  if (result.status === 'exists') toast(t('toast.exists'), { id: 'add-to-library' });
  else if (result.type === 'artist') toast(t('toast.importing'), { id: 'add-to-library' });
  else toast.success(t('toast.added'), { id: 'add-to-library' });
  return result;
}
