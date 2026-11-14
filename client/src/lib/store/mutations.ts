import { ApiError } from '@/lib/api/errors';
import type { Db } from '@/lib/db';
import type { LibraryStore } from './library';

export type Mutation<T> = {
  /** Мгновенно применяет изменение к store. */
  apply(): void;
  /** Запрос к серверу (бросает `ApiError`). */
  request(): Promise<T>;
  /** Откатывает `apply`, если запрос не удался. */
  rollback(): void;
};

export type MutationDeps = {
  db: Db;
  store: LibraryStore;
  requestSync(reason: string): void;
  /** `POST /api/tracks/{id}/played`. */
  postPlayed(trackId: number): Promise<unknown>;
  isOnline?: () => boolean;
  now?: () => number;
};

const defaultOnline = () => globalThis.navigator?.onLine !== false;

/** Сеть недоступна или сервер временно сломан: запрос стоит повторить позже. */
export const isRetryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e.status === 0 && e.code === 'network' ? new ApiError(0, 'offline', e.message) : e;
  return new ApiError(0, 'unknown', e instanceof Error ? e.message : String(e));
}

export function createMutations(deps: MutationDeps) {
  const { db, store } = deps;
  const isOnline = deps.isOnline ?? defaultOnline;
  const now = deps.now ?? Date.now;
  let flushing: Promise<void> | null = null;
  let detach: (() => void) | null = null;

  /**
   * Оптимистичная мутация: применить к store → запрос → при ошибке откат и `ApiError` (toast показывает
   * вызывающий код). После успеха — синхронизация. Без сети — сразу ошибка `offline`, store не трогается.
   */
  async function mutate<T>(m: Mutation<T>): Promise<T> {
    if (!isOnline()) throw new ApiError(0, 'offline', 'You are offline');
    m.apply();
    try {
      const result = await m.request();
      deps.requestSync('mutation');
      return result;
    } catch (e) {
      m.rollback();
      throw toApiError(e);
    }
  }

  /**
   * Прослушивание трека. Единственная мутация с outbox: нет сети/5xx — запись откладывается и уйдёт позже
   * (счётчик в store уже увеличен); 4xx — откат и ошибка.
   */
  async function recordPlay(trackId: number): Promise<void> {
    const before = store.getState().tracks.get(trackId);
    if (before) {
      store.getState().patchTrack(trackId, {
        last_played_at: new Date(now()).toISOString(),
        play_count: before.play_count + 1,
      });
    }
    const rollback = () => {
      if (before) {
        store.getState().patchTrack(trackId, { last_played_at: before.last_played_at, play_count: before.play_count });
      }
    };
    try {
      if (!isOnline()) throw new ApiError(0, 'offline', 'You are offline');
      await deps.postPlayed(trackId);
      deps.requestSync('played');
    } catch (e) {
      if (isRetryable(e) || (e instanceof ApiError && e.code === 'offline')) {
        await db.outboxAdd({ at: now(), trackId });
        return;
      }
      rollback();
      throw toApiError(e);
    }
  }

  /** Отправляет отложенные прослушивания по порядку. 4xx — запись отбрасывается, сеть/5xx — остаётся. */
  function flushOutbox(): Promise<void> {
    flushing ??= (async () => {
      let sent = false;
      for (const item of (await db.outboxAll()).sort((a, b) => a.id - b.id)) {
        try {
          await deps.postPlayed(item.trackId);
          sent = true;
        } catch (e) {
          if (isRetryable(e)) break;
          // Сервер отверг запись (например, трека уже нет) — повторять бессмысленно.
        }
        await db.outboxRemove(item.id);
      }
      if (sent) deps.requestSync('outbox');
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  /** Отправляет накопленное сейчас и при каждом появлении сети. */
  function start(): void {
    if (detach) return;
    const onOnline = () => void flushOutbox().catch(() => undefined);
    globalThis.addEventListener('online', onOnline);
    detach = () => globalThis.removeEventListener('online', onOnline);
    onOnline();
  }

  function stop(): void {
    detach?.();
    detach = null;
  }

  return { flushOutbox, mutate, recordPlay, start, stop };
}

export type Mutations = ReturnType<typeof createMutations>;
