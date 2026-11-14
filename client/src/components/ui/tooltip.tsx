import * as Ariakit from '@ariakit/react';
import type { ReactElement } from 'react';

/** Подсказка при наведении и фокусе. Оборачивает один элемент; текст подсказки дополняет, а не заменяет `aria-label`. */
export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  return (
    <Ariakit.TooltipProvider timeout={300}>
      <Ariakit.TooltipAnchor render={children} />
      <Ariakit.Tooltip className="z-[95] max-w-60 rounded-lg bg-black px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-white dark:text-black">
        {text}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}
