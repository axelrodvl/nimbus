import { SEEK_STEP_S, type PlayerController } from './controller';
import { currentTrack } from './engine';

// Элементы, в которых клавиши ←/→/пробел заняты самим элементом.
export function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
    t.getAttribute('role') === 'slider' ||
    t.getAttribute('role') === 'textbox'
  );
}

// Пробел на кнопке/ссылке — штатная активация этого элемента.
export function activatesOnSpace(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement && (['BUTTON', 'A', 'SUMMARY'].includes(t.tagName) || t.getAttribute('role') === 'button')
  );
}

/**
 * Горячие клавиши: пробел — пауза/продолжить; ←/→ — перемотка на 5 с; Shift+←/→ — предыдущий/следующий.
 * Не срабатывают с модификаторами и в полях ввода. Возвращает функцию снятия.
 */
export function installShortcuts(
  player: PlayerController,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  function onKey(e: Event) {
    const ev = e as KeyboardEvent;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isEditable(ev.target)) return;
    if (!currentTrack(player.state)) return;
    if (ev.code === 'Space') {
      if (activatesOnSpace(ev.target)) return;
      ev.preventDefault();
      player.togglePlayPause();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const dir = ev.key === 'ArrowLeft' ? -1 : 1;
      if (ev.shiftKey) {
        if (dir < 0) player.previous();
        else player.next();
      } else player.seekTo(player.positionNow() + dir * SEEK_STEP_S);
    }
  }
  const onHide = () => player.persist();
  target.addEventListener('keydown', onKey);
  target.addEventListener('pagehide', onHide);
  return () => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('pagehide', onHide);
  };
}
