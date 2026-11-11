'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { FORMAT_LABELS } from '@/features/settings/types';

// Порядок форматов стрелками; значения уходят в форму скрытыми полями `format_prefs`.
export function FormatOrder({ initial }: { initial: string[] }) {
  const [order, setOrder] = useState(initial);
  const move = (i: number, d: -1 | 1) =>
    setOrder(prev => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  return (
    <ol data-testid="format-order" className="flex max-w-xs flex-col gap-1">
      {order.map((f, i) => (
        <li key={f} className="bg-card dark:bg-card-dark flex items-center gap-2 rounded px-3 py-1.5 text-sm">
          <input type="hidden" name="format_prefs" value={f} />
          <span className="text-muted w-4 font-mono text-xs">{i + 1}</span>
          <span className="flex-1">{FORMAT_LABELS[f] ?? f}</span>
          <button
            type="button"
            aria-label={`Выше: ${FORMAT_LABELS[f] ?? f}`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
            className="disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Ниже: ${FORMAT_LABELS[f] ?? f}`}
            disabled={i === order.length - 1}
            onClick={() => move(i, 1)}
            className="disabled:opacity-30"
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
          </button>
        </li>
      ))}
    </ol>
  );
}
