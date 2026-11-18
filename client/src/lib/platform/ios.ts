/** iPhone/iPad/iPod (в т. ч. iPadOS, который выдаёт себя за Mac, но имеет мультитач). */
export function isAppleTouch(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints' | 'platform'> | undefined = globalThis.navigator,
): boolean {
  if (!nav) return false;
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
}

/** Приложение запущено с домашнего экрана (standalone), где нет кнопок и жестов браузера. */
export function isStandalone(
  win:
    | { matchMedia?: (q: string) => { matches: boolean }; navigator?: { standalone?: boolean } }
    | undefined = globalThis as never,
): boolean {
  return !!(win?.matchMedia?.('(display-mode: standalone)').matches || win?.navigator?.standalone);
}
