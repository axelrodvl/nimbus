import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const isMac = () => /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? '');

/** Подсказка клавиш палитры: ⌘K на macOS/iOS, Ctrl K на остальных. */
export function ShortcutHint({ className }: { className?: string }) {
  const mac = useSyncExternalStore(subscribe, isMac, () => false);
  return (
    <kbd aria-hidden className={className}>
      {mac ? '⌘K' : 'Ctrl K'}
    </kbd>
  );
}
