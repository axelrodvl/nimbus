import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { LOCALE_COOKIE, isLocale, negotiateLocale, type Locale } from './config';
import { loadMessages, type Messages, type TFn } from './messages';
import { translate } from './translate';

export type { TFn };

/** Язык запроса: cookie → Accept-Language → английский. Делает рендер динамическим. */
export const getLocale = cache(async (): Promise<Locale> => {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  return negotiateLocale((await headers()).get('accept-language'));
});

export const getMessages = cache(async (): Promise<Messages> => loadMessages(await getLocale()));

export async function getT(): Promise<TFn> {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (key, params) => translate(messages, locale, key, params);
}
