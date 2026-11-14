import { createStore, type StoreApi } from 'zustand/vanilla';

export type SyncState = 'idle' | 'hydrating' | 'snapshot' | 'delta' | 'live' | 'error' | 'offline';

export type SyncStatus = {
  state: SyncState;
  /** Время последней успешной синхронизации (мс с эпохи). */
  lastSyncedAt: number | null;
  error: Error | null;
  /** Ход снимка: принято строк (всего заранее неизвестно). */
  progress: { received: number; total?: number } | null;
};

export type SyncStatusStore = StoreApi<SyncStatus>;

export const createSyncStatusStore = (): SyncStatusStore =>
  createStore<SyncStatus>()(() => ({ error: null, lastSyncedAt: null, progress: null, state: 'idle' }));
