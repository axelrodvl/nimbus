import type { OfflineManager } from './manager';
import type { OfflineStatusStore } from './status';

/** Состояние для проверок в e2e: простые объекты вместо `Map`/`Set`. */
export type OfflineE2eHook = {
  pin(kind: 'track' | 'album' | 'playlist', id: number): Promise<void>;
  unpin(kind: 'track' | 'album' | 'playlist', id: number): Promise<void>;
  retry(trackId: number): void;
  setPaused(value: boolean): void;
  removeAll(): Promise<void>;
  state(): {
    files: Record<number, { state: string; bytesDone: number; bytesTotal: number | null }>;
    pins: string[];
    blocked: string;
    usage: { bytes: number; quota: number | null; limit: number };
    activeCount: number;
    queueLength: number;
  };
};

/**
 * Управление офлайн-менеджером из страницы — только для e2e-сборки (`VITE_UI_GALLERY=1`) и dev: интерфейса
 * скачивания в шаге 46 ещё нет (он в шаге 47). В обычную сборку не попадает: условие вычисляется при сборке.
 */
export function installOfflineE2eHook(manager: OfflineManager, status: OfflineStatusStore, target: object = window): void {
  const hook: OfflineE2eHook = {
    pin: (kind, id) => manager.pin(kind, id),
    removeAll: () => manager.removeAll(),
    retry: id => manager.retry(id),
    setPaused: v => manager.setPaused(v),
    state() {
      const s = status.getState();
      return {
        activeCount: s.activeCount,
        blocked: s.blocked,
        files: Object.fromEntries(
          [...s.files].map(([id, f]) => [id, { bytesDone: f.bytesDone, bytesTotal: f.bytesTotal, state: f.state }]),
        ),
        pins: [...s.pins],
        queueLength: s.queueLength,
        usage: s.usage,
      };
    },
    unpin: (kind, id) => manager.unpin(kind, id),
  };
  const holder = target as { __nimbus?: Record<string, unknown> };
  holder.__nimbus = { ...holder.__nimbus, offline: hook };
}
