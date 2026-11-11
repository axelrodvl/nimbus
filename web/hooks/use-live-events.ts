'use client';

import { useEffect, useRef } from 'react';
import type { LiveEventOf, LiveEventType } from '@/lib/api/events';
import { useLiveEventsContext } from '@/providers/live-events-provider';

// Подписка на события одного типа. Обработчик можно не мемоизировать:
// всегда вызывается актуальная версия, а подписка не пересоздаётся.
export function useLiveEvent<T extends LiveEventType>(type: T, handler: (event: LiveEventOf<T>) => void) {
  const { subscribe } = useLiveEventsContext();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(
    () =>
      subscribe(event => {
        if (event.type === type) handlerRef.current(event as LiveEventOf<T>);
      }),
    [subscribe, type],
  );
}

export function useConnectionState() {
  return useLiveEventsContext().state;
}
