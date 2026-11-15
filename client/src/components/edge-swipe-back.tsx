import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { idleSwipe, swipeEnd, swipeMove, swipeStart, yieldsToOwner, type EdgeSwipeState } from '@/lib/gestures/edge-swipe';
import { isAppleTouch, isStandalone } from '@/lib/platform/ios';
import { scrollRoot } from '@/lib/nav/scroll-top';

const SETTLE_MS = 180;

/** Есть ли куда возвращаться: react-router хранит порядковый номер записи в `history.state.idx`. */
const canGoBack = () => Number((history.state as { idx?: number } | null)?.idx ?? 0) > 0;
const dialogOpen = () => document.querySelector('[role="dialog"]:not([hidden]), [data-dialog][data-open]') !== null;

/**
 * Смахивание «назад» от левого края — только в установленном приложении на iOS (там нет кнопки браузера; на Android
 * жест системный). Экран следует за пальцем; недотянули — возвращается. Уступает элементам с `data-gesture="own"`
 * (полноэкранный плеер, ползунки, карусели) и не работает при открытых диалогах.
 */
export function EdgeSwipeBack() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAppleTouch() || !isStandalone()) return;
    let state: EdgeSwipeState = idleSwipe;
    const el = () => scrollRoot()?.parentElement ?? null;
    const shift = (dx: number, animate: boolean) => {
      const target = el();
      if (!target) return;
      target.style.transition = animate ? `translate ${SETTLE_MS}ms ease-out` : 'none';
      target.style.translate = dx ? `${dx}px 0` : '';
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || !canGoBack() || dialogOpen() || yieldsToOwner(e.target)) {
        state = idleSwipe;
        return;
      }
      state = swipeStart(t.clientX, t.clientY, e.timeStamp);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      state = swipeMove(state, t.clientX, t.clientY, e.timeStamp);
      if (state.phase === 'dragging') {
        e.preventDefault();
        shift(state.dx, false);
      }
    };
    const onEnd = () => {
      const result = swipeEnd(state);
      state = idleSwipe;
      if (result === 'commit') {
        shift(window.innerWidth, true);
        setTimeout(() => {
          void navigate(-1);
          shift(0, false);
        }, SETTLE_MS);
      } else if (result === 'cancel') shift(0, true);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      shift(0, false);
    };
  }, [navigate]);
  return null;
}
