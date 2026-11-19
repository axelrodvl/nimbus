import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigation } from 'react-router';
import {
  idleSwipe,
  swipeEnd,
  swipeMove,
  swipeStart,
  yieldsToOwner,
  type EdgeSwipeState,
} from '@/lib/gestures/edge-swipe';
import { isAppleTouch, isStandalone } from '@/lib/platform/ios';
import { scrollRoot } from '@/lib/nav/scroll-top';

const SETTLE_MS = 180;
/** Переход «назад» не начался (его перехватили) — экран возвращается на место; пока роутер грузит маршрут — ждём. */
export const SWIPE_RESET_TIMEOUT_MS = 1500;

/** Есть ли куда возвращаться: react-router хранит порядковый номер записи в `history.state.idx`. */
const canGoBack = () => Number((history.state as { idx?: number } | null)?.idx ?? 0) > 0;
const contentEl = () => scrollRoot()?.parentElement ?? null;
function shift(dx: number, animate: boolean) {
  const target = contentEl();
  if (!target) return;
  target.style.transition = animate ? `translate ${SETTLE_MS}ms ease-out` : 'none';
  target.style.translate = dx ? `${dx}px 0` : '';
}
const dialogOpen = () => document.querySelector('[role="dialog"]:not([hidden]), [data-dialog][data-open]') !== null;

/**
 * Смахивание «назад» от левого края — только в установленном приложении на iOS (там нет кнопки браузера; на Android
 * жест системный). Экран следует за пальцем; недотянули — возвращается. Уступает элементам с `data-gesture="own"`
 * (полноэкранный плеер, ползунки, карусели) и не работает при открытых диалогах.
 *
 * Уехавший экран остаётся за краем, пока роутер не сменил экран: вернуть его на место сразу после `navigate(-1)` —
 * значит на кадр показать уходящий экран снова (переход «назад» асинхронный). Прежний экран появляется на месте
 * в том же коммите, что и монтируется, — уже на своей позиции прокрутки.
 */
export function EdgeSwipeBack() {
  const navigate = useNavigate();
  const { key } = useLocation();
  // Роутер грузит маршрут (loader каталога, чанк): переход идёт, возвращать уехавший экран нельзя.
  const navigation = useNavigation().state;
  const loading = useRef(false);
  useLayoutEffect(() => {
    loading.current = navigation !== 'idle';
  }, [navigation]);
  // Таймер страховки: экран уехал, ждём смены записи истории. Пока он взведён, новый жест не начинается.
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (leaving.current === null) return;
    clearTimeout(leaving.current);
    leaving.current = null;
    shift(0, false);
  }, [key]);
  useEffect(() => {
    if (!isAppleTouch() || !isStandalone()) return;
    let state: EdgeSwipeState = idleSwipe;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const busy = leaving.current !== null;
      if (!t || busy || e.touches.length > 1 || !canGoBack() || dialogOpen() || yieldsToOwner(e.target)) {
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
        const fallback = () => {
          if (loading.current) {
            leaving.current = setTimeout(fallback, SWIPE_RESET_TIMEOUT_MS);
            return;
          }
          leaving.current = null;
          shift(0, true);
        };
        // Взводится сразу: жест засчитан, повторный до смены экрана не начнётся.
        leaving.current = setTimeout(() => {
          leaving.current = setTimeout(fallback, SWIPE_RESET_TIMEOUT_MS);
          void navigate(-1);
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
      if (leaving.current !== null) clearTimeout(leaving.current);
      leaving.current = null;
      shift(0, false);
    };
  }, [navigate]);
  return null;
}
