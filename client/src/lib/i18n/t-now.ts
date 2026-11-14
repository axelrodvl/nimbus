import { enMessages, type TFn } from './messages';
import { i18n } from './store';
import { translate } from './translate';

/** Перевод вне React (toast из не-компонентов) на текущем языке интерфейса. */
export const tNow: TFn = (key, params) => {
  const { locale, messages } = i18n.getState();
  return translate(messages, locale, key, params, enMessages);
};
