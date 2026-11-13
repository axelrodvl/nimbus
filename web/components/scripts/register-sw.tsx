'use client';

import { useEffect } from 'react';

// Регистрирует service worker, кэширующий обложки и фото артистов (public/sw.js).
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
