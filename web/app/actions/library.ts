'use server';

export type AddToLibraryInput =
  | { type: 'artist'; mbid: string }
  | { type: 'album'; mbid: string }
  | { type: 'track'; mbid: string; album_mbid?: string | null };

// ЗАГЛУШКА: реальное добавление подключит шаг 11 (после бэкенд-эндпоинта шага 10).
export async function addToLibrary(input: AddToLibraryInput): Promise<void> {
  void input;
  throw new Error('not implemented');
}
