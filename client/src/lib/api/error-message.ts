import type { MessageKey, TFn } from '@/lib/i18n/messages';
import { ApiError } from './errors';

/**
 * Текст ошибки для пользователя: перевод по коду (`error.<code>`: `offline`, `mb_not_found`, …), иначе сообщение
 * сервера; ошибка без кода (`unknown`) — общее «не удалось загрузить».
 */
export function apiErrorMessage(error: unknown, t: TFn): string {
  if (error instanceof ApiError) {
    const key = `error.${error.code}` as MessageKey;
    const text = t(key);
    if (text !== key) return text;
    return error.code === 'unknown' ? t('common.loadFailed') : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
