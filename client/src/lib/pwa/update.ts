// Регистрация service worker и обновления. Новая версия не применяется сама: пользователь нажимает «Обновить»
// (SKIP_WAITING → controllerchange → перезагрузка). Перезагрузка по чужому controllerchange (другая вкладка) —
// никогда: иначе она оборвала бы музыку.

export type SwWorker = {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
};
export type SwRegistration = {
  waiting: SwWorker | null;
  installing: SwWorker | null;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', listener: () => void): void;
};
export type SwContainer = {
  controller: unknown;
  register(url: string, options?: { scope?: string }): Promise<SwRegistration>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
};

export const VERSION_KEY = 'nimbus:pwa:version';
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type UpdaterDeps = {
  container: SwContainer | null;
  /** Версия этой сборки (`__APP_VERSION__`). */
  version: string;
  /** Предложить обновление; `apply` применяет его и перезагружает страницу. */
  offerUpdate: (apply: () => void, playing: boolean) => void;
  /** Одноразовое сообщение после обновления. */
  announceUpdated: (version: string) => void;
  isPlaying: () => boolean;
  /** Подписка на остановку воспроизведения (пауза, конец очереди): отложенное обновление применяется тогда. */
  onPause?: (listener: () => void) => () => void;
  reload: () => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Вкладка вернулась на передний план — проверить обновления. */
  onVisible?: (listener: () => void) => () => void;
  swUrl?: string;
};

export function createUpdater(deps: UpdaterDeps) {
  let registration: SwRegistration | null = null;
  let waiting: SwWorker | null = null;
  let applying = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopVisible: (() => void) | null = null;

  function announceIfUpdated() {
    try {
      const previous = deps.storage?.getItem(VERSION_KEY);
      if (previous && previous !== deps.version) deps.announceUpdated(deps.version);
      deps.storage?.setItem(VERSION_KEY, deps.version);
    } catch {
      // Хранилище — удобство.
    }
  }

  let stopPauseWatch: (() => void) | null = null;

  function applyNow() {
    stopPauseWatch?.();
    stopPauseWatch = null;
    if (!waiting) return;
    applying = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  /** Обновление не прерывает музыку: во время воспроизведения откладывается до паузы (или холодного старта). */
  function apply() {
    if (!waiting) return;
    if (!deps.isPlaying() || !deps.onPause) {
      applyNow();
      return;
    }
    stopPauseWatch?.();
    stopPauseWatch = deps.onPause(() => {
      if (!deps.isPlaying()) applyNow();
    });
  }

  function offer(worker: SwWorker) {
    // Уже предложено: одно предложение на одну версию.
    if (waiting === worker) return;
    waiting = worker;
    deps.offerUpdate(apply, deps.isPlaying());
  }

  function watch(worker: SwWorker) {
    worker.addEventListener('statechange', () => {
      // Первая установка (контроллера ещё нет) — не обновление.
      if (worker.state === 'installed' && deps.container?.controller) offer(worker);
    });
  }

  async function check() {
    try {
      await registration?.update();
    } catch {
      // Нет сети — проверим в следующий раз.
    }
  }

  return {
    check,
    /** Применить обновление (кнопка «Обновить»). */
    apply,
    async start(): Promise<void> {
      announceIfUpdated();
      const container = deps.container;
      if (!container) return;
      container.addEventListener('controllerchange', () => {
        if (applying) deps.reload();
      });
      try {
        registration = await container.register(deps.swUrl ?? '/sw.js', { scope: '/' });
      } catch {
        return;
      }
      if (registration.waiting && container.controller) offer(registration.waiting);
      registration.addEventListener('updatefound', () => {
        if (registration?.installing) watch(registration.installing);
      });
      void check();
      timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
      stopVisible = deps.onVisible?.(() => void check()) ?? null;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stopPauseWatch?.();
      stopPauseWatch = null;
      stopVisible?.();
      stopVisible = null;
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
