import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Locale } from './config';
import type { TFn } from './messages';
import { enMessages } from './messages';
import { i18n, type I18nStore } from './store';
import { translate } from './translate';

export type { TFn };

type I18nValue = { locale: Locale; t: TFn };

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children, store = i18n }: { children: ReactNode; store?: I18nStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const value = useMemo<I18nValue>(
    () => ({
      locale: state.locale,
      // Запасной словарь — en: ключ, которого нет в выбранном языке, не показывается «сырым».
      t: (key, params) => translate(state.messages, state.locale, key, params, enMessages),
    }),
    [state],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}

function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useT/useLocale must be used within I18nProvider');
  return ctx;
}

export const useT = (): TFn => useI18n().t;
export const useLocale = (): Locale => useI18n().locale;
