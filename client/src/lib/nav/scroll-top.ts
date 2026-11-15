/** Маркер прокручиваемого контейнера оболочки (`<main>`): к нему «возвращает наверх» повторное нажатие на вкладку. */
export const SCROLL_ROOT_ATTR = 'data-scroll-root';

/**
 * Повторное нажатие на активную вкладку: прокрутить экран к началу (как в нативных приложениях).
 * Возвращает, была ли прокрутка нужна (экран не в самом верху).
 */
export function scrollToTop(root: HTMLElement | null, reducedMotion: boolean): boolean {
  if (!root || root.scrollTop <= 0) return false;
  root.scrollTo({ behavior: reducedMotion ? 'auto' : 'smooth', top: 0 });
  return true;
}

export function scrollRoot(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[${SCROLL_ROOT_ATTR}]`);
}
