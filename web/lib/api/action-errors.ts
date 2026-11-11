import 'server-only';

import { ApiError } from '@/lib/api/errors';
import type { MessageKey } from '@/lib/i18n/messages';
import { getT } from '@/lib/i18n/server';

export type ActionFailure = { ok: false; code: string; message: string };

// Коды ошибок бэкенда, для которых есть перевод; остальные показываются как пришли от бэкенда.
const KNOWN = {
  backend_unavailable: 'error.backend_unavailable',
  invalid_magnet: 'error.invalid_magnet',
  mb_not_found: 'error.mb_not_found',
  mb_unavailable: 'error.mb_unavailable',
  recording_not_in_release: 'error.recording_not_in_release',
  track_ready: 'error.track_ready',
} as const satisfies Record<string, MessageKey>;

export async function actionFailure(e: unknown): Promise<ActionFailure> {
  const t = await getT();
  if (e instanceof ApiError) {
    const key = (KNOWN as Record<string, MessageKey>)[e.code];
    return { code: e.code, message: key ? t(key) : e.message, ok: false };
  }
  return { code: 'backend_unavailable', message: t('error.backend_unavailable'), ok: false };
}
