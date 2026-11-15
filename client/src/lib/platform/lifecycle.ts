// Жизненный цикл приложения: единственный источник событий «ушли в фон / вернулись / связь» для всех подписчиков.
// Браузер сообщает об одном и том же переходе несколькими событиями (`visibilitychange`, `pageshow`, `resume`,
// `focus`): здесь они сводятся к одному `foreground` на каждый возврат и одному `background` на каждый уход.

export type LifecycleEvent = 'foreground' | 'background' | 'online' | 'offline';
export type LifecycleListener = () => void;

/** Часть окружения, нужная модулю (в тестах — фейк). */
export type LifecycleTarget = {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
};

export type LifecycleDeps = {
  win?: LifecycleTarget;
  doc?: LifecycleTarget & { visibilityState: string };
};

export function createLifecycle(deps: LifecycleDeps = {}) {
  const win = deps.win ?? globalThis.window;
  const doc = deps.doc ?? (globalThis.document as unknown as NonNullable<LifecycleDeps['doc']>);
  const listeners: Record<LifecycleEvent, Set<LifecycleListener>> = {
    background: new Set(),
    foreground: new Set(),
    offline: new Set(),
    online: new Set(),
  };
  /** Приложение сейчас на переднем плане (по последнему обработанному переходу). */
  let foreground = doc?.visibilityState !== 'hidden';
  let attached = false;

  const emit = (event: LifecycleEvent) => {
    for (const l of [...listeners[event]]) {
      try {
        l();
      } catch {
        // Сбой одного подписчика не должен лишать остальных события.
      }
    }
  };
  const toForeground = () => {
    if (foreground) return;
    foreground = true;
    emit('foreground');
  };
  const toBackground = () => {
    if (!foreground) return;
    foreground = false;
    emit('background');
  };

  const onVisibility = () => (doc.visibilityState === 'hidden' ? toBackground() : toForeground());
  const handlers: [LifecycleTarget | undefined, string, (e: Event) => void][] = [
    [doc, 'visibilitychange', onVisibility],
    // bfcache: страница вернулась из кэша — `visibilitychange` может не прийти.
    [win, 'pageshow', () => toForeground()],
    [win, 'pagehide', () => toBackground()],
    [doc, 'freeze', () => toBackground()],
    [doc, 'resume', () => toForeground()],
    [win, 'online', () => emit('online')],
    [win, 'offline', () => emit('offline')],
  ];

  function attach() {
    if (attached) return;
    attached = true;
    for (const [target, type, fn] of handlers) target?.addEventListener(type, fn);
  }
  function detach() {
    if (!attached) return;
    attached = false;
    for (const [target, type, fn] of handlers) target?.removeEventListener(type, fn);
  }

  return {
    isForeground: () => foreground,
    /** Подписка; возвращает отписку. Браузерные слушатели ставятся при первой подписке. */
    on(event: LifecycleEvent, listener: LifecycleListener): () => void {
      attach();
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
        if (Object.values(listeners).every(s => s.size === 0)) detach();
      };
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;

let instance: Lifecycle | null = null;

/** Единственный источник событий жизненного цикла вкладки. */
export function lifecycle(): Lifecycle {
  instance ??= createLifecycle();
  return instance;
}
