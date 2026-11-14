import { useEffect, useState } from 'react';

/** Текущее время, обновляемое раз в `intervalMs`: для подписей вроде «через 5 мин», которые не должны устаревать. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
