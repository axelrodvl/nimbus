import { toast } from 'sonner';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { addToLibraryRequest, type AddInput, type AddResult } from '@/lib/api/search';
import { apiErrorMessage } from '@/lib/api/error-message';
import { appData } from '@/lib/app-data';
import type { TFn } from '@/lib/i18n/messages';
import { addToHistory } from './history';

/**
 * Какие `mbid` сейчас добавляются. Живёт вне компонентов: кнопка не теряет состояние при переходах между
 * экранами. Запись снимается, когда сущность появилась в store (или запрос не удался).
 */
export const addingStore = createStore<{ adding: ReadonlySet<string>; set: (mbid: string, on: boolean) => void }>(
  set => ({
    adding: new Set(),
    set: (mbid, on) =>
      set(s => {
        if (s.adding.has(mbid) === on) return s;
        const next = new Set(s.adding);
        if (on) next.add(mbid);
        else next.delete(mbid);
        return { adding: next };
      }),
  }),
);

export const useIsAdding = (mbid: string): boolean => useStore(addingStore, s => s.adding.has(mbid));
export const finishAdding = (mbid: string): void => addingStore.getState().set(mbid, false);

/** Текст ошибки добавления: перевод по коду (`error.mb_not_found`), иначе сообщение сервера. */
export const addErrorMessage = apiErrorMessage;

/** Если дельта не принесла сущность за это время, кнопка возвращается в исходное состояние. */
export const ADDING_TIMEOUT_MS = 30_000;

export type AddDeps = {
  post?: (input: AddInput) => Promise<AddResult>;
  requestSync?: (reason: string) => void;
};

/**
 * Добавить в библиотеку. Оптимистично только состояние кнопки (локального id ещё нет): `POST` → `requestSync`,
 * «добавляется» держится, пока дельта не принесёт сущность. Второй вызов с тем же `mbid` — без запроса.
 * Возвращает `true`, если запрос ушёл и прошёл.
 */
export async function addToLibrary(input: AddInput, t: TFn, query?: string, deps: AddDeps = {}): Promise<boolean> {
  const { adding, set } = addingStore.getState();
  if (adding.has(input.mbid)) return false;
  set(input.mbid, true);
  try {
    const result = await (deps.post ?? addToLibraryRequest)(input);
    if (query) addToHistory(query);
    (deps.requestSync ?? (reason => appData().engine.requestSync(reason)))('add');
    setTimeout(() => finishAdding(input.mbid), ADDING_TIMEOUT_MS);
    toast.success(
      t(
        result.status === 'exists' ? 'toast.exists' : result.status === 'importing' ? 'toast.importing' : 'toast.added',
      ),
    );
    return true;
  } catch (error) {
    set(input.mbid, false);
    toast.error(addErrorMessage(error, t));
    return false;
  }
}
