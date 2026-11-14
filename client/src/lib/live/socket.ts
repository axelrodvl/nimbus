import { createStore, type StoreApi } from 'zustand/vanilla';
import { liveSocketUrl } from '@/lib/platform/urls';

export type SocketState = 'connecting' | 'open' | 'closed';
export type LiveEvent = { type: string } & Record<string, unknown>;
export type LiveEventHandler = (event: LiveEvent) => void;

export const SOCKET_MIN_DELAY_MS = 1000;
export const SOCKET_MAX_DELAY_MS = 30_000;

/** Часть интерфейса `WebSocket`, которая нужна модулю (в тестах подставляется фейк). */
export type SocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
};

const CONNECTING = 0;

export type LiveSocketDeps = {
  /** Адрес сокета; по умолчанию — `liveSocketUrl()` (cookie уходит сама, тот же origin). */
  url?: () => string;
  createSocket?: (url: string) => SocketLike;
  /** Каждое принятое событие (раньше подписчиков). */
  onEvent?: LiveEventHandler;
  /** Соединение (пере)установлено. */
  onOpen?: () => void;
  random?: () => number;
};

/**
 * Начальное состояние — `connecting` (соединение стартует вместе с приложением; без этого на миг мигало бы «нет связи»).
 * Одно WebSocket-соединение: переподключение с экспоненциальной паузой (1 с → 30 с, джиттер ±20 %),
 * пауза сбрасывается после успешного подключения. Не зависит от React и от видимости вкладки.
 */
export function createLiveSocket(deps: LiveSocketDeps = {}) {
  const url = deps.url ?? liveSocketUrl;
  const make = deps.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const random = deps.random ?? Math.random;
  const state: StoreApi<{ state: SocketState }> = createStore(() => ({ state: 'connecting' as SocketState }));
  const handlers = new Set<LiveEventHandler>();
  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let running = false;

  const set = (next: SocketState) => state.setState({ state: next });

  function detach(s: SocketLike) {
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    // Закрытие во время подключения даёт предупреждение браузера (двойной монтаж в dev): закрываем по открытию.
    if (s.readyState === CONNECTING) s.onopen = () => s.close();
    else {
      s.onopen = null;
      s.close();
    }
  }

  function connect() {
    timer = null;
    set('connecting');
    const s = make(url());
    socket = s;
    s.onopen = () => {
      attempt = 0;
      set('open');
      deps.onOpen?.();
    };
    s.onmessage = message => {
      let event: LiveEvent;
      try {
        const parsed: unknown = JSON.parse(String(message.data));
        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as LiveEvent).type !== 'string') return;
        event = parsed as LiveEvent;
      } catch {
        return;
      }
      deps.onEvent?.(event);
      handlers.forEach(h => h(event));
    };
    s.onerror = () => s.close();
    s.onclose = () => {
      if (!running) return;
      socket = null;
      set('closed');
      const base = Math.min(SOCKET_MAX_DELAY_MS, SOCKET_MIN_DELAY_MS * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, base * (0.8 + random() * 0.4));
    };
  }

  return {
    /** Принудительное переподключение сейчас (кнопка «повторить»). */
    reconnect() {
      if (!running) return;
      if (timer) clearTimeout(timer);
      timer = null;
      if (socket) {
        const old = socket;
        socket = null;
        detach(old);
      }
      connect();
    },
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      connect();
    },
    state,
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (socket) detach(socket);
      socket = null;
      set('closed');
    },
    /** Подписка на события; `type` — только этого типа. Возвращает отписку. */
    subscribe(handler: LiveEventHandler, type?: string): () => void {
      const wrapped: LiveEventHandler = type ? e => e.type === type && handler(e) : handler;
      handlers.add(wrapped);
      return () => handlers.delete(wrapped);
    },
  };
}

export type LiveSocket = ReturnType<typeof createLiveSocket>;
