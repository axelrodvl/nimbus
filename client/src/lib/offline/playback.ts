import type { AudioSource } from '@/lib/player/audio/types';
import type { OfflineStatusStore } from './status';
import type { OfflineStorage } from './types';

/**
 * Сколько источников держим открытыми: текущий, следующий и один запасной — смена очереди во время игры меняет «следующий»,
 * и вытеснять источник играющего трека нельзя (адрес отзывается — перемотка и перезапуск ломаются).
 */
export const SOURCE_CACHE_SIZE = 3;

export type OfflinePlayback = {
  /** Скачан ли трек (файл готов к воспроизведению). */
  has(trackId: number): boolean;
  /**
   * Источник офлайн-трека: из кэша — синхронно (жест iOS), иначе — `Promise`; `null` — трека нет на устройстве.
   * Всегда `direct`, даже если на сервере трек перекодируется: сохранён уже перекодированный результат.
   */
  resolve(trackId: number): AudioSource | Promise<AudioSource> | null;
  /** Готовит источник заранее (при постановке в очередь), чтобы к клику он уже был в кэше. */
  prepare(trackId: number): void;
  /** Файл не воспроизвёлся: источник освобождается, менеджер вернёт трек в очередь. */
  broken(trackId: number): void;
  /** Меняется, когда меняется набор треков, доступных без сети (для `useSyncExternalStore`). */
  version(): number;
  subscribe(listener: () => void): () => void;
};

export type PlaybackDeps = {
  storage: OfflineStorage;
  status: OfflineStatusStore;
  /** Сообщить менеджеру (в любой вкладке), что файл повреждён. */
  markBroken(trackId: number): unknown;
};

/**
 * Связь «скачанные файлы → плеер». Кэш на несколько последних запрошенных треков; вытесненный источник сразу
 * освобождается (`storage.release`): объектный адрес держит файл открытым, и утечка адреса — утечка места на диске.
 */
export function createOfflinePlayback({ storage, status, markBroken }: PlaybackDeps): OfflinePlayback {
  const cache = new Map<number, AudioSource>();
  const pending = new Map<number, Promise<AudioSource>>();
  /** Файлы, которые не воспроизвелись: считаем недоступными, пока менеджер не вернёт их в очередь. */
  const suspect = new Set<number>();

  const mimeOf = (trackId: number) => status.getState().files.get(trackId)?.mime ?? 'application/octet-stream';

  function remember(trackId: number, src: AudioSource) {
    cache.delete(trackId);
    cache.set(trackId, src);
    while (cache.size > SOURCE_CACHE_SIZE) {
      const oldest = cache.keys().next().value as number;
      cache.delete(oldest);
      storage.release(String(oldest));
    }
  }

  const has = (trackId: number) => status.getState().files.get(trackId)?.state === 'done' && !suspect.has(trackId);

  function load(trackId: number): Promise<AudioSource> {
    let p = pending.get(trackId);
    if (!p) {
      p = storage.source(String(trackId), mimeOf(trackId)).then(
        src => {
          pending.delete(trackId);
          remember(trackId, src);
          return src;
        },
        e => {
          pending.delete(trackId);
          throw e;
        },
      );
      pending.set(trackId, p);
    }
    return p;
  }

  // Набор доступных без сети треков: по нему перерисовываются кнопки воспроизведения.
  let version = 0;
  let doneIds = new Set<number>();
  const listeners = new Set<() => void>();
  const syncDone = () => {
    const next = new Set<number>();
    for (const [id, f] of status.getState().files) if (f.state === 'done' && !suspect.has(id)) next.add(id);
    if (next.size === doneIds.size && [...next].every(id => doneIds.has(id))) return;
    doneIds = next;
    version++;
    for (const l of [...listeners]) l();
  };
  syncDone();

  // Файл исчез из состояния (удалён, возвращён в очередь) — источник больше не нужен.
  status.subscribe((s, prev) => {
    if (s.files === prev.files) return;
    for (const id of [...cache.keys()]) {
      if (s.files.get(id)?.state !== 'done') {
        cache.delete(id);
        storage.release(String(id));
      }
    }
    for (const id of [...suspect]) if (s.files.get(id)?.state !== 'done') suspect.delete(id);
    syncDone();
  });

  return {
    broken(trackId) {
      suspect.add(trackId);
      cache.delete(trackId);
      storage.release(String(trackId));
      syncDone();
      void markBroken(trackId);
    },
    has,
    prepare(trackId) {
      if (has(trackId) && !cache.has(trackId)) load(trackId).catch(() => undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
    resolve(trackId) {
      if (!has(trackId)) return null;
      const hit = cache.get(trackId);
      if (hit) {
        remember(trackId, hit); // самый свежий
        return hit;
      }
      return load(trackId);
    },
  };
}
