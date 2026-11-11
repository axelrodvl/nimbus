'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '@/lib/api/events';
import { publicBackendUrl } from '@/lib/env';

export type ConnectionState = 'connecting' | 'open' | 'closed';
export type LiveEventHandler = (event: LiveEvent) => void;

type LiveEventsContextValue = {
  state: ConnectionState;
  subscribe: (handler: LiveEventHandler) => () => void;
};

const LiveEventsContext = createContext<LiveEventsContextValue | null>(null);

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function wsUrl(base: string = publicBackendUrl) {
  return `${base.replace(/^http/, 'ws')}/api/ws`;
}

// Одно WebSocket-соединение на вкладку, автопереподключение с задержкой 1 с → 30 с.
export function LiveEventsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const handlers = useRef(new Set<LiveEventHandler>());

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      socket = new WebSocket(wsUrl());
      socket.onopen = () => {
        attempt = 0;
        setState('open');
      };
      socket.onmessage = message => {
        let event: LiveEvent;
        try {
          event = JSON.parse(String(message.data)) as LiveEvent;
        } catch {
          return;
        }
        handlers.current.forEach(handler => handler(event));
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setState('closed');
        const delay = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(() => {
          setState('connecting');
          connect();
        }, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  const subscribe = (handler: LiveEventHandler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  };

  return <LiveEventsContext value={{ state, subscribe }}>{children}</LiveEventsContext>;
}

export function useLiveEventsContext() {
  const ctx = useContext(LiveEventsContext);
  if (!ctx) throw new Error('useLiveEvent/useConnectionState must be used within LiveEventsProvider');
  return ctx;
}
