import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

export type SortableItem = { id: string; label: string };

/** Переносит элемент `from` на позицию `to`; возвращает новый массив. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

type Props = {
  items: readonly SortableItem[];
  onReorder: (ids: string[]) => void;
  disabled?: boolean;
  'aria-label': string;
  'data-testid'?: string;
};

/**
 * Список с порядком, который задаёт пользователь: перетаскивание за «ручку» (на касаниях прокрутка списка не мешает —
 * жест начинается только с ручки) и кнопки вверх/вниз для клавиатуры и скринридеров.
 */
export function SortableList({ items, onReorder, disabled, ...rest }: Props) {
  const t = useT();
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  function indexAt(y: number): number {
    const i = rows.current.findIndex(el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    return i;
  }

  function onPointerDown(e: PointerEvent, from: number) {
    if (disabled) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ from, over: from });
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    const over = indexAt(e.clientY);
    if (over >= 0 && over !== drag.over) setDrag({ ...drag, over });
  }
  function onPointerUp() {
    if (!drag) return;
    const { from, over } = drag;
    setDrag(null);
    if (from !== over) onReorder(moveItem(items, from, over).map(i => i.id));
  }

  const move = (from: number, to: number) => onReorder(moveItem(items, from, to).map(i => i.id));

  const btn =
    'text-muted focus-visible:ring-accent/40 flex size-9 items-center justify-center rounded-full outline-none hover:text-black focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-30 dark:hover:text-white pointer-coarse:size-11';
  return (
    <ol className="flex flex-col gap-1.5" {...rest}>
      {items.map((item, i) => (
        <li
          className={cn(
            'border-divider dark:border-divider-dark flex items-center gap-1 rounded-xl border px-1.5 py-0.5',
            drag?.from === i && 'bg-card dark:bg-card-dark opacity-70',
            drag && drag.over === i && drag.from !== i && 'border-accent',
          )}
          key={item.id}
          ref={el => {
            rows.current[i] = el;
          }}
        >
          <span
            aria-hidden
            className={cn(
              'text-muted flex size-9 touch-none items-center justify-center rounded-full pointer-coarse:size-11',
              disabled ? 'opacity-30' : 'cursor-grab',
            )}
            data-testid={`handle-${item.id}`}
            onPointerCancel={() => setDrag(null)}
            onPointerDown={e => onPointerDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <GripVertical className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate px-1 text-sm">{item.label}</span>
          <button
            aria-label={t('form.moveUp', { name: item.label })}
            className={btn}
            disabled={disabled || i === 0}
            onClick={() => move(i, i - 1)}
            type="button"
          >
            <ArrowUp aria-hidden className="size-4" />
          </button>
          <button
            aria-label={t('form.moveDown', { name: item.label })}
            className={btn}
            disabled={disabled || i === items.length - 1}
            onClick={() => move(i, i + 1)}
            type="button"
          >
            <ArrowDown aria-hidden className="size-4" />
          </button>
        </li>
      ))}
    </ol>
  );
}
