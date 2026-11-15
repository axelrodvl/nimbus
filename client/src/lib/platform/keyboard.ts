// Экранная клавиатура. Android Chrome сам уменьшает область страницы (`interactive-widget=resizes-content` в viewport);
// iOS Safari — нет: уменьшается только `visualViewport`. Следим за ним и сообщаем CSS через атрибут и переменную.

/** Разница высот, начиная с которой считаем, что открыта клавиатура (адресная строка меняет высоту на меньшую величину). */
export const KEYBOARD_MIN_PX = 120;

/** Открыта ли экранная клавиатура: видимая область заметно ниже окна и в фокусе поле ввода. */
export function isKeyboardOpen(layoutHeight: number, visualHeight: number, inputFocused: boolean): boolean {
  return inputFocused && layoutHeight - visualHeight >= KEYBOARD_MIN_PX;
}

export type KeyboardTargets = {
  win: Pick<Window, 'innerHeight' | 'addEventListener' | 'removeEventListener'> & {
    visualViewport?: Pick<VisualViewport, 'height' | 'addEventListener' | 'removeEventListener'> | null;
  };
  doc: Pick<Document, 'activeElement' | 'addEventListener' | 'removeEventListener'> & {
    documentElement: { dataset: DOMStringMap; style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> };
  };
};

const isInput = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true);

/** Ставит `data-keyboard="open"` и `--vvh` на `<html>`; возвращает отписку. Без `visualViewport` — ничего не делает. */
export function watchKeyboard({ win, doc }: KeyboardTargets = { doc: document, win: window }): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = doc.documentElement;
  const update = () => {
    const open = isKeyboardOpen(win.innerHeight, vv.height, isInput(doc.activeElement));
    if (open) {
      root.dataset.keyboard = 'open';
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    } else {
      delete root.dataset.keyboard;
      root.style.removeProperty('--vvh');
    }
  };
  vv.addEventListener('resize', update);
  doc.addEventListener('focusin', update);
  doc.addEventListener('focusout', update);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    doc.removeEventListener('focusin', update);
    doc.removeEventListener('focusout', update);
    delete root.dataset.keyboard;
    root.style.removeProperty('--vvh');
  };
}
