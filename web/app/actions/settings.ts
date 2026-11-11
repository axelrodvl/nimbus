'use server';

import type { Settings } from '@/features/settings/types';
import { actionFailure } from '@/lib/api/action-errors';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Частичный объект настроек (merge на бэкенде). */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export async function saveSettings(patch: SettingsPatch): Promise<ActionResult<{ settings: Settings }>> {
  try {
    const settings = unwrap(await api.PUT('/api/settings', { body: patch as never })) as unknown as Settings;
    return { ok: true, settings };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function testProvider(
  provider: 'tpb' | 'rutracker' | 'torznab',
): Promise<ActionResult<{ message: string; success: boolean; sampleCount: number }>> {
  try {
    const r = unwrap(await api.POST('/api/settings/providers/test', { body: { provider } }));
    return { message: r.message, ok: true, sampleCount: r.sample_count, success: r.ok };
  } catch (e) {
    return actionFailure(e);
  }
}

/** Нужна ли предзагрузка следующего трека (настройка `playback.prefetch_next`). */
export async function loadPrefetchEnabled(): Promise<boolean> {
  try {
    const s = unwrap(await api.GET('/api/settings')) as unknown as Settings;
    return s.playback.prefetch_next;
  } catch {
    return true;
  }
}

/** Предзагрузка начала следующего трека (бэкенд качает в фоне; ошибки не важны). */
export async function prefetchTrack(trackId: number): Promise<void> {
  try {
    await api.POST('/api/tracks/{id}/prefetch', { params: { path: { id: trackId } } });
  } catch {
    /* предзагрузка — best effort */
  }
}
