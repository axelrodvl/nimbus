import type { Locale } from './config';

// Сообщение — строка с подстановками `{name}` либо набор форм множественного числа
// (`one`/`few`/`many`/`other` и т.д. по `Intl.PluralRules`); число берётся из параметра `count`.
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | PluralForms;
export type Params = Record<string, string | number>;

export function translate(
  messages: Record<string, Message>,
  locale: Locale,
  key: string,
  params?: Params,
  fallback?: Record<string, Message>,
): string {
  const message = messages[key] ?? fallback?.[key];
  if (message === undefined) return key;
  let text: string;
  if (typeof message === 'string') text = message;
  else {
    const count = Number(params?.count ?? 0);
    const category = new Intl.PluralRules(locale).select(count);
    text = message[category] ?? message.other;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
