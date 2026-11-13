'use client';

import { useEffect } from 'react';

// iOS home-screen (standalone) PWAs sometimes launch with a stale, too-short viewport (a dead strip
// under the tab bar) that only recovers once the document is scrolled — e.g. by the user dragging
// the bottom bar. Do the same programmatically: a 1px scroll there and back. When the viewport is
// healthy the document is not scrollable and this is a no-op.
export function IosViewportHeal() {
  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    if (!standalone) return;

    const heal = () => {
      const root = document.documentElement;
      const prev = root.style.minHeight;
      // Guarantee there is something to scroll, even if the stale viewport is not visibly short.
      root.style.minHeight = 'calc(100% + 1px)';
      window.scrollTo(0, 1);
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        root.style.minHeight = prev;
      });
    };

    const timers = [0, 150, 500, 1500].map(ms => window.setTimeout(heal, ms));
    const onChange = () => window.setTimeout(heal, 150);
    window.addEventListener('pageshow', onChange);
    document.addEventListener('visibilitychange', onChange);
    document.addEventListener('focusout', onChange);
    return () => {
      timers.forEach(window.clearTimeout);
      window.removeEventListener('pageshow', onChange);
      document.removeEventListener('visibilitychange', onChange);
      document.removeEventListener('focusout', onChange);
    };
  }, []);
  return null;
}
