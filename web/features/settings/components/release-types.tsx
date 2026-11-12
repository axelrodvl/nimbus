'use client';

import { useState } from 'react';
import { RELEASE_TYPES } from '@/features/settings/types';

/** Переключатели типов релизов. Выключенные уходят в форму скрытыми полями `skip_types`. */
export function ReleaseTypes({ skipped }: { skipped: string[] }) {
  const [off, setOff] = useState(() => new Set(skipped));
  const toggle = (type: string) =>
    setOff(prev => {
      const next = new Set(prev);
      if (!next.delete(type)) next.add(type);
      return next;
    });
  // Типы вне известного списка (заданные вручную раньше) остаются пропущенными.
  const unknown = skipped.filter(s => !(RELEASE_TYPES as readonly string[]).includes(s));
  return (
    <div data-testid="release-types" className="flex flex-wrap gap-2">
      {RELEASE_TYPES.map(type => {
        const on = !off.has(type);
        return (
          <button
            key={type}
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => toggle(type)}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
              on
                ? 'bg-accent border-transparent text-white'
                : 'border-divider dark:border-divider-dark text-muted hover:bg-card dark:hover:bg-card-dark'
            }`}
          >
            {type}
          </button>
        );
      })}
      {RELEASE_TYPES.filter(type => off.has(type))
        .concat(unknown as never[])
        .map(type => (
          <input key={type} type="hidden" name="skip_types" value={type} />
        ))}
    </div>
  );
}
