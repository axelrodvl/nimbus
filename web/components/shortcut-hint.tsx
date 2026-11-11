'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const isMac = () => /mac|iphone|ipad/i.test(navigator.platform);

// Подсказка клавиш: ⌘K на macOS/iOS, Ctrl K на остальных.
export function ShortcutHint({ className }: { className?: string }) {
  const mac = useSyncExternalStore(subscribe, isMac, () => false);
  return (
    <kbd className={className} aria-hidden suppressHydrationWarning>
      {mac ? '⌘K' : 'Ctrl K'}
    </kbd>
  );
}
