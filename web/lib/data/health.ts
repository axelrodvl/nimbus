import 'server-only';

import { cacheLife, cacheTag } from 'next/cache';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export type Health = { ok: true; version: string } | { ok: false };

// Недоступный бэкенд — штатная ситуация, не ошибка рендера.
export async function getHealth(): Promise<Health> {
  'use cache';
  cacheTag('health');
  cacheLife('seconds');

  try {
    const data = unwrap(await api.GET('/api/health'));
    return { ok: data.status === 'ok' && data.db, version: data.version } as Health;
  } catch {
    return { ok: false };
  }
}
