import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const isMac = () => /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? '');

/** Текст клавиш палитры: ⌘K на macOS/iOS, Ctrl K на остальных. */
export function useShortcutText(): string {
  return useSyncExternalStore(subscribe, isMac, () => false) ? '⌘K' : 'Ctrl K';
}

/** Подсказка клавиш палитры (визуальная; в `aria-label` кнопки та же строка — имя содержит видимый текст). */
export function ShortcutHint({ className }: { className?: string }) {
  return (
    <kbd aria-hidden className={className}>
      {useShortcutText()}
    </kbd>
  );
}
