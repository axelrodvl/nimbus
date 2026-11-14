export type Platform = 'web' | 'ios' | 'android' | 'desktop';

/** Платформа, в которой запущен клиент. Нативные оболочки (фаза 4) подменят значение; в PWA всегда `web`. */
export function platform(): Platform {
  return 'web';
}

/** Запущен ли клиент внутри нативной оболочки (не в браузере). */
export function isNative(): boolean {
  return platform() !== 'web';
}
