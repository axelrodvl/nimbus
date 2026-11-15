// Долгое нажатие: срабатывает через `delay` мс неподвижного касания; сдвиг дальше `tolerance` px или отпускание
// раньше отменяют. Чистая машина состояний с таймером, который передаёт вызывающий (в тестах — fake timers).

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_TOLERANCE_PX = 10;

export type LongPressOptions = {
  onTrigger: (point: { x: number; y: number }) => void;
  delay?: number;
  tolerance?: number;
};

export function createLongPress({
  onTrigger,
  delay = LONG_PRESS_MS,
  tolerance = LONG_PRESS_TOLERANCE_PX,
}: LongPressOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: { x: number; y: number } | null = null;
  /** Жест сработал: следующий `click` (отпускание пальца) нужно подавить. */
  let fired = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    origin = null;
  };

  return {
    cancel,
    /** Подавить `click`, следующий за сработавшим долгим нажатием; сбрасывает признак. */
    consumeClick(): boolean {
      const was = fired;
      fired = false;
      return was;
    },
    move(x: number, y: number) {
      if (!origin) return;
      if (Math.hypot(x - origin.x, y - origin.y) > tolerance) cancel();
    },
    start(x: number, y: number) {
      cancel();
      fired = false;
      origin = { x, y };
      timer = setTimeout(() => {
        const at = origin;
        cancel();
        if (!at) return;
        // Сначала действие (оно может программно «кликнуть» по кнопке внутри элемента), затем признак подавления.
        onTrigger(at);
        fired = true;
      }, delay);
    },
    end: cancel,
  };
}
