'use client';

import { useEffect } from 'react';

// iOS home-screen (standalone) PWAs sometimes keep a stale, too-short viewport (a dead strip under
// the tab bar) until WebKit is forced to recompute layout. Toggling `display` on the root forces it.
export function IosViewportHeal() {
  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    if (!standalone) return;

    const heal = () => {
      // Healthy: the layout viewport spans the whole screen. Stale: it is shorter.
      if (screen.height - window.innerHeight <= 4) return;
      const body = document.body;
      const prev = body.style.display;
      body.style.display = 'none';
      void body.offsetHeight;
      body.style.display = prev;
    };

    const timers = [0, 150, 500, 1500].map(ms => window.setTimeout(heal, ms));
    const onChange = () => window.setTimeout(heal, 150);
    window.addEventListener('resize', onChange);
    window.addEventListener('pageshow', onChange);
    document.addEventListener('visibilitychange', onChange);
    document.addEventListener('focusout', onChange);
    return () => {
      timers.forEach(window.clearTimeout);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('pageshow', onChange);
      document.removeEventListener('visibilitychange', onChange);
      document.removeEventListener('focusout', onChange);
    };
  }, []);
  return null;
}
