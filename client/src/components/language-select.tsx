import { LOCALES, isLocale } from '@/lib/i18n/config';
import { useLocale, useT } from '@/lib/i18n/provider';
import { setLocale } from '@/lib/i18n/store';

/** Выбор языка интерфейса. Названия языков — на самих языках, чтобы их находили при любом текущем. */
export function LanguageSelect({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  return (
    <label className={className ?? 'flex max-w-xs flex-col gap-1 text-sm'}>
      <span className="sr-only">{t('language.label')}</span>
      <select
        className="border-divider dark:border-divider-dark focus-visible:ring-accent/40 w-full rounded-lg border bg-transparent px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:outline-none"
        data-testid="language-select"
        onChange={e => {
          if (isLocale(e.target.value)) void setLocale(e.target.value);
        }}
        value={locale}
      >
        {LOCALES.map(l => (
          <option className="text-black" key={l.code} lang={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
