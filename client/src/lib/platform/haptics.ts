// Тактильный отклик. В PWA — `navigator.vibrate` (только Android); iOS API не даёт, там — тихо ничего.
// Нативные оболочки (шаг 53) подставят настоящий haptic engine через `setHaptics`.

export type HapticKind = 'tap' | 'select';

export type Haptics = { impact(kind: HapticKind): void };

const PATTERN: Record<HapticKind, number> = { select: 8, tap: 15 };

export function createWebHaptics(
  nav: { vibrate?: (p: number) => boolean } | undefined = globalThis.navigator,
): Haptics {
  return {
    impact(kind) {
      try {
        nav?.vibrate?.(PATTERN[kind]);
      } catch {
        // Политика браузера (нет жеста пользователя) — не ошибка.
      }
    },
  };
}

let current: Haptics | null = null;

export const haptics = (): Haptics => (current ??= createWebHaptics());

/** Подмена реализации (нативная оболочка, тесты). */
export function setHaptics(h: Haptics | null): void {
  current = h;
}
