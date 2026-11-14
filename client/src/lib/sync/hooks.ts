import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { SyncStatus } from './status';

/** Состояние синхронизации (для индикаторов оболочки). */
export const useSyncStatus = (): SyncStatus => useStore(appData().engine.status);
