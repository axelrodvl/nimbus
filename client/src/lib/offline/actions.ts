import { offline } from './index';
import { expectCompletion, forgetCompletion } from './notify';
import { FAVORITES_PIN_ID } from './status';
import type { PinKind } from './derive';

/** Что закрепляется: сущность и её треки (для снятия отдельных закреплений и повтора неудавшихся). */
export type OfflineSubject = { kind: PinKind; id: number; title: string; trackIds: readonly number[] };

export const pinKey = (kind: PinKind, id: number) => `${kind}:${id}`;

export const favoritesSubject = (title: string, trackIds: readonly number[]): OfflineSubject => ({
  id: FAVORITES_PIN_ID,
  kind: 'playlist',
  title,
  trackIds,
});

/** Закрепить: после завершения придёт toast. */
export async function pinSubject(s: OfflineSubject): Promise<void> {
  const manager = offline().manager;
  if (!manager) return;
  expectCompletion(pinKey(s.kind, s.id), s.title);
  await manager.pin(s.kind, s.id);
}

/**
 * Удалить с устройства (или отменить скачивание): снимает закрепление сущности и закрепления её треков по отдельности,
 * иначе файлы остались бы по закреплению трека.
 */
export async function removeSubject(s: OfflineSubject): Promise<void> {
  const manager = offline().manager;
  if (!manager) return;
  forgetCompletion(pinKey(s.kind, s.id));
  await manager.unpin(s.kind, s.id);
  if (s.kind !== 'track') for (const id of s.trackIds) await manager.unpin('track', id);
}

/** Повторить неудавшиеся загрузки этих треков. */
export function retryTracks(trackIds: readonly number[]): void {
  const manager = offline().manager;
  const files = offline().status.getState().files;
  for (const id of trackIds) if (files.get(id)?.state === 'failed') manager?.retry(id);
}

/** Повторить все неудавшиеся. */
export function retryAllFailed(): void {
  const { manager, status } = offline();
  for (const [id, f] of status.getState().files) if (f.state === 'failed') manager?.retry(id);
}

export const setOfflinePaused = (value: boolean): void => offline().manager?.setPaused(value);
