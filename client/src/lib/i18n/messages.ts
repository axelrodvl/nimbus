import { en } from './messages/en';
import type { Locale } from './config';
import type { Message, Params } from './translate';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, Message>;
export type TFn = (key: MessageKey, params?: Params) => string;

/** Английский словарь — в основном бандле: он же запасной для ключей, которых нет в других языках. */
export const enMessages: Messages = en;

// Остальные словари подгружаются по требованию (отдельные чанки).
const loaders: Record<Locale, () => Promise<{ default: Messages }>> = {
  de: () => import('./messages/de'),
  en: () => Promise.resolve({ default: enMessages }),
  es: () => import('./messages/es'),
  fr: () => import('./messages/fr'),
  hi: () => import('./messages/hi'),
  it: () => import('./messages/it'),
  ja: () => import('./messages/ja'),
  ko: () => import('./messages/ko'),
  pl: () => import('./messages/pl'),
  pt: () => import('./messages/pt'),
  ru: () => import('./messages/ru'),
  tr: () => import('./messages/tr'),
  uk: () => import('./messages/uk'),
  zh: () => import('./messages/zh'),
};

export async function loadMessages(locale: Locale): Promise<Messages> {
  return (await loaders[locale]()).default;
}
