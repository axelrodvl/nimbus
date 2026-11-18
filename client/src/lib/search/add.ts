import { toast } from 'sonner';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { addToLibraryRequest, type AddInput, type AddResult } from '@/lib/api/search';
import { apiErrorMessage } from '@/lib/api/error-message';
import { appData } from '@/lib/app-data';
import type { TFn } from '@/lib/i18n/messages';
import type { MbidIndex } from '@/lib/store/selectors';
import { addToHistory } from './history';

/** Как показать добавляемое до прихода дельты: данные из результата поиска. */
export type AddPreview = {
  title: string;
  /** Артист (для альбома и трека). */
  artistName?: string | null;
  cover?: string | null;
};

/** Запрос на добавление и, если есть, то, как показать сущность, пока она едет в store. */
export type AddRequest = AddInput & { preview?: AddPreview };

/** Добавляемая сущность: видна в «Недавно добавленных» и библиотеке сразу после нажатия. */
export type PendingAdd = {
  mbid: string;
  type: AddInput['type'];
  preview: AddPreview | null;
  /** Время нажатия (мс): новые сверху. */
  at: number;
};

type AddingState = {
  adding: ReadonlyMap<string, PendingAdd>;
  start: (item: PendingAdd) => void;
  finish: (mbid: string) => void;
};

/**
 * Какие `mbid` сейчас добавляются. Живёт вне компонентов: кнопка и заглушки в библиотеке не теряют состояние при
 * переходах между экранами. Запись снимается, когда сущность появилась в store (или запрос не удался).
 */
export const addingStore = createStore<AddingState>(set => ({
  adding: new Map(),
  finish: mbid =>
    set(s => {
      if (!s.adding.has(mbid)) return s;
      const next = new Map(s.adding);
      next.delete(mbid);
      return { adding: next };
    }),
  start: item =>
    set(s => {
      if (s.adding.has(item.mbid)) return s;
      return { adding: new Map(s.adding).set(item.mbid, item) };
    }),
}));

export const useIsAdding = (mbid: string): boolean => useStore(addingStore, s => s.adding.has(mbid));
export const finishAdding = (mbid: string): void => addingStore.getState().finish(mbid);

/** Уже в store: заглушка больше не нужна (а «добавляется» на кнопке — снимается). */
export function isInIndex(item: Pick<PendingAdd, 'mbid' | 'type'>, index: MbidIndex): boolean {
  if (item.type === 'artist') return index.artists.has(item.mbid);
  if (item.type === 'album') return index.albums.has(item.mbid);
  return index.tracks.has(item.mbid);
}

/** Добавляемые сущности, которых ещё нет в store, — новые сверху; `type` сужает до одного вида. */
export function pendingAdds(
  adding: ReadonlyMap<string, PendingAdd>,
  index: MbidIndex,
  type?: PendingAdd['type'],
): PendingAdd[] {
  return [...adding.values()]
    .filter(p => (type === undefined || p.type === type) && !isInIndex(p, index))
    .sort((a, b) => b.at - a.at);
}

export const usePendingAdds = (index: MbidIndex, type?: PendingAdd['type']): PendingAdd[] =>
  useStore(
    addingStore,
    useShallow(s => pendingAdds(s.adding, index, type)),
  );

/** Текст ошибки добавления: перевод по коду (`error.mb_not_found`), иначе сообщение сервера. */
export const addErrorMessage = apiErrorMessage;

/** Если дельта не принесла сущность за это время после ответа сервера, «добавляется» снимается. */
export const ADDING_TIMEOUT_MS = 30_000;

export type AddDeps = {
  post?: (input: AddInput) => Promise<AddResult>;
  requestSync?: (reason: string) => void;
  now?: () => number;
};

/**
 * Добавить в библиотеку. Оптимистично: сразу после нажатия сущность видна как «добавляется» — на кнопке, в
 * «Недавно добавленных» и в библиотеке (по `preview`); локального id ещё нет, поэтому это отдельный список, а не
 * store. `POST` → `requestSync`, заглушка держится, пока дельта не принесёт сущность. Второй вызов с тем же
 * `mbid` — без запроса. Возвращает `true`, если запрос ушёл и прошёл.
 */
export async function addToLibrary(request: AddRequest, t: TFn, query?: string, deps: AddDeps = {}): Promise<boolean> {
  const { preview, ...input } = request;
  const { adding, start } = addingStore.getState();
  if (adding.has(input.mbid)) return false;
  start({ at: (deps.now ?? Date.now)(), mbid: input.mbid, preview: preview ?? null, type: input.type });
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
    finishAdding(input.mbid);
    toast.error(addErrorMessage(error, t));
    return false;
  }
}
