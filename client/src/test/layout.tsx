import { useState, type ReactNode } from 'react';
import { ScrollContainerProvider } from '@/components/ui/scroll-container';

/**
 * happy-dom не считает раскладку: размеры элементов задаются прототипными геттерами, чтобы виртуализатор
 * видел окно прокрутки заданного размера. Возвращает функцию отката.
 */
export function mockLayout({ width = 1000, height = 600 }: { width?: number; height?: number } = {}): () => void {
  const props = { clientHeight: height, clientWidth: width, offsetHeight: height, offsetWidth: width } as const;
  const saved = Object.entries(props).map(
    ([key]) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
  );
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, key);
    }
  };
}

/** Прокручиваемый контейнер оболочки для тестов виртуальных списков. */
export function ScrollHost({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  return (
    <div data-testid="scroll-host" ref={setElement} style={{ height: 600, overflow: 'auto' }}>
      <ScrollContainerProvider value={element}>{children}</ScrollContainerProvider>
    </div>
  );
}
