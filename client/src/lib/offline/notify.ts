import type { TFn } from '@/lib/i18n/messages';
import type { LibraryStore } from '@/lib/store/library';
import { summarizePins } from './derive';
import type { OfflineStatusStore } from './status';

export const NOTIFY_KEY = 'nimbus:offline-notify';
/** Сколько ждать, собирая завершения в один сводный toast. */
export const NOTIFY_BATCH_MS = 400;

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;
/** Ключ закрепления → название (на языке, на котором пользователь нажал «Скачать»). */
type Pending = Map<string, string>;

function safeStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage: KeyValue | null): Pending {
  try {
    const raw = storage?.getItem(NOTIFY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return new Map();
  }
}

function write(storage: KeyValue | null, pending: Pending) {
  try {
    storage?.setItem(NOTIFY_KEY, JSON.stringify(Object.fromEntries(pending)));
  } catch {
    // Без хранилища уведомление придёт только в этой вкладке до перезагрузки.
  }
}

/**
 * Запоминает, что о завершении этого закрепления надо сообщить. Запись переживает перезагрузку страницы:
 * закрепление, начатое до неё и законченное после, даёт ровно один toast.
 */
export function expectCompletion(key: string, title: string, storage: KeyValue | null = safeStorage()): void {
  write(storage, read(storage).set(key, title));
}

/** Забыть ожидание (закрепление снято). */
export function forgetCompletion(key: string, storage: KeyValue | null = safeStorage()): void {
  const pending = read(storage);
  if (pending.delete(key)) write(storage, pending);
}

type ToastApi = {
  success(message: string, opts?: { id?: string }): unknown;
  warning(message: string, opts?: { id?: string; action?: { label: string; onClick: () => void } }): unknown;
  error(message: string, opts?: { id?: string }): unknown;
};

export type NotifierDeps = {
  status: OfflineStatusStore;
  library: LibraryStore;
  favoriteIds(): number[];
  t: TFn;
  toast: ToastApi;
  openSettings(): void;
  storage?: KeyValue | null;
  batchMs?: number;
};

/**
 * Уведомления офлайн-движка: закрепление целиком доступно (один toast на закрепление, при нескольких сразу — один
 * сводный), загрузка остановилась из-за места (с переходом в настройки), трек окончательно не скачался.
 */
export function createOfflineNotifier(deps: NotifierDeps) {
  const { status, library, toast } = deps;
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  const batchMs = deps.batchMs ?? NOTIFY_BATCH_MS;
  const done = new Set<string>();
  const failed = new Set<number>();
  const seen = new Map<number, string>();
  let lastBlocked = 'none';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  let disposed = false;

  function flush() {
    timer = undefined;
    const t = deps.t;
    // Переписываем ожидания заново: другая вкладка могла уже сообщить о том же закреплении.
    const pending = read(storage);
    const titles: string[] = [];
    for (const key of done) {
      const title = pending.get(key);
      if (title === undefined) continue;
      titles.push(title);
      pending.delete(key);
    }
    done.clear();
    if (titles.length > 0) {
      write(storage, pending);
      toast.success(
        titles.length === 1
          ? t('offline.toast.done', { title: titles[0] ?? '' })
          : t('offline.toast.doneMany', { count: titles.length }),
        {
          id: titles.length === 1 ? `offline-done-${titles[0]}` : 'offline-done',
        },
      );
    }
    if (failed.size > 0) {
      const lib = library.getState();
      const firstId = [...failed][0];
      const title = firstId === undefined ? '' : (lib.tracks.get(firstId)?.title ?? '');
      toast.error(
        failed.size === 1
          ? t('offline.toast.failedOne', { title })
          : t('offline.toast.failedMany', { count: failed.size }),
        {
          id: 'offline-failed',
        },
      );
      failed.clear();
    }
  }

  const arm = () => {
    timer ??= setTimeout(flush, batchMs);
  };

  function check() {
    scheduled = false;
    if (disposed) return;
    const s = status.getState();
    if (!s.supported) return;
    const lib = library.getState();

    const pending = read(storage);
    if (pending.size > 0 && lib.hydrated) {
      const sums = new Map(summarizePins(s, lib, deps.favoriteIds()).map(p => [p.key, p]));
      let changed = false;
      for (const key of [...pending.keys()]) {
        const sum = sums.get(key);
        if (!sum) {
          // Закрепление снято (пользователем или сверкой) — сообщать не о чем.
          if (s.pins.size > 0 || s.files.size > 0 || done.has(key)) {
            pending.delete(key);
            changed = true;
          }
        } else if (sum.total > 0 && sum.state.kind === 'done' && !done.has(key)) {
          done.add(key);
          arm();
        }
      }
      if (changed) write(storage, pending);
    }

    if (s.blocked === 'quota' && lastBlocked !== 'quota') {
      toast.warning(deps.t('offline.toast.quota'), {
        action: { label: deps.t('offline.toast.openSettings'), onClick: deps.openSettings },
        id: 'offline-quota',
      });
    }
    lastBlocked = s.blocked;

    // Окончательная ошибка — переход в `failed` у трека, за которым мы наблюдали (не загруженный уже упавшим).
    for (const [id, f] of s.files) {
      if (f.state === 'failed' && seen.has(id) && seen.get(id) !== 'failed') {
        failed.add(id);
        arm();
      }
      seen.set(id, f.state);
    }
    for (const id of [...seen.keys()]) if (!s.files.has(id)) seen.delete(id);
  }

  const request = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(check);
  };
  const offStatus = status.subscribe(request);
  const offLibrary = library.subscribe(request);
  request();

  return {
    /** Синхронная проверка (тесты). */
    check,
    dispose() {
      disposed = true;
      offStatus();
      offLibrary();
      clearTimeout(timer);
    },
  };
}
