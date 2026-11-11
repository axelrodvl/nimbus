'use client';

import { createContext, useContext, useEffect, useMemo } from 'react';
import type { Locale } from '@/lib/i18n/config';
import type { Messages, TFn } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

export type { TFn };

type I18nValue = { locale: Locale; t: TFn };

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  // Сервер отдаёт статический `<html lang>`: уточняем язык документа на клиенте.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({ locale, t: (key, params) => translate(messages, locale, key, params) }),
    [locale, messages],
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
