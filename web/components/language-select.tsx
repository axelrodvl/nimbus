'use client';

import { useTransition } from 'react';
import { setLocale } from '@/app/actions/locale';
import { LOCALES } from '@/lib/i18n/config';
import { useLocale, useT } from '@/providers/i18n-provider';

// Выбор языка интерфейса. Названия языков — на самих языках, чтобы их можно было найти при любом текущем.
export function LanguageSelect({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  const [pending, start] = useTransition();
  return (
    <label className={className ?? 'flex max-w-xs flex-col gap-1 text-sm'}>
      <span className="font-medium">{t('language.label')}</span>
      <select
        data-testid="language-select"
        value={locale}
        disabled={pending}
        onChange={e => start(() => setLocale(e.target.value))}
        className="border-divider dark:border-divider-dark rounded-lg border bg-transparent px-3 py-2 text-sm"
      >
        {LOCALES.map(l => (
          <option key={l.code} value={l.code} lang={l.code} className="text-black">
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
