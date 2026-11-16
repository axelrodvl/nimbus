import { createStore, type StoreApi } from 'zustand/vanilla';
import type { OfflineSettings } from './types';

export const SETTINGS_KEY = 'nimbus:offline-settings';
export const MAX_DEFAULT_LIMIT = 20 * 2 ** 30;
export const DEFAULT_SETTINGS: OfflineSettings = { concurrency: 3, limitBytes: null, wifiOnly: false };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Приводит прочитанное к допустимым значениям (повреждённые поля заменяются значениями по умолчанию). */
export function normalizeSettings(raw: unknown): OfflineSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const limit =
    typeof o.limitBytes === 'number' && Number.isFinite(o.limitBytes) && o.limitBytes >= 0 ? o.limitBytes : null;
  const conc = typeof o.concurrency === 'number' && Number.isFinite(o.concurrency) ? Math.round(o.concurrency) : 3;
  return { concurrency: clamp(conc, 1, 6), limitBytes: limit, wifiOnly: o.wifiOnly === true };
}

/** Лимит по умолчанию — половина квоты хранилища, но не более 20 ГБ; квота неизвестна — 20 ГБ. */
export function effectiveLimit(settings: OfflineSettings, quota: number | null): number {
  if (settings.limitBytes !== null) return settings.limitBytes;
  return quota === null ? MAX_DEFAULT_LIMIT : Math.min(Math.floor(quota / 2), MAX_DEFAULT_LIMIT);
}

export type OfflineSettingsStore = StoreApi<OfflineSettings> & {
  /** Частичное обновление с сохранением в `localStorage`. */
  update(patch: Partial<OfflineSettings>): void;
};

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

/** Настройки устройства (не синхронизируются с сервером) в `localStorage['nimbus:offline-settings']`. */
export function createOfflineSettings(storage: KeyValue | null = safeStorage()): OfflineSettingsStore {
  let initial = DEFAULT_SETTINGS;
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    if (raw) initial = normalizeSettings(JSON.parse(raw));
  } catch {
    // Повреждённое значение — настройки по умолчанию.
  }
  const store = createStore<OfflineSettings>(() => initial);
  return Object.assign(store, {
    update(patch: Partial<OfflineSettings>) {
      const next = normalizeSettings({ ...store.getState(), ...patch });
      store.setState(next, true);
      try {
        storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Хранилище недоступно: настройка действует до перезагрузки.
      }
    },
  });
}

function safeStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
