'use client';

import { toast } from 'sonner';
import { addToLibrary } from '@/app/actions/library';
import type { AddToLibraryInput } from '@/app/actions/library';

// Добавляет в библиотеку; при ошибке (пока Server Function — заглушка) показывает toast.
export async function addToLibraryWithToast(input: AddToLibraryInput): Promise<boolean> {
  try {
    await addToLibrary(input);
    return true;
  } catch {
    toast('Скоро будет', { id: 'add-to-library' });
    return false;
  }
}
