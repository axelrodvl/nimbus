import { toast } from 'sonner';
import { tNow } from '@/lib/i18n/t-now';
import { appData, notifyUnauthorized } from '@/lib/app-data';
import { createDb } from '@/lib/db';
import { isOnlineNow } from '@/lib/live/online';
import { authHeaders } from '@/lib/platform/auth-transport';
import { platform } from '@/lib/platform/platform';
import { downloadUrl } from '@/lib/platform/urls';
import { createTabs } from '@/lib/sync/tabs';
import { createOfflineManager, type OfflineManager, type OfflineTabMessage } from './manager';
import { browserOpfsDeps, createOpfsStorage } from './opfs-storage';
import { createOfflinePlayback, type OfflinePlayback } from './playback';
import { createOfflineSettings, type OfflineSettingsStore } from './settings';
import { createOfflineStatusStore, type OfflineStatusStore } from './status';
import type { Downloader, OfflineStorage } from './types';
import { createWorkerDownloader, type WorkerLike } from './worker-downloader';

export * from './status';
export type { OfflineManager } from './manager';
export type { OfflineSettings, OfflineStorage, Downloader } from './types';
export type { OfflinePlayback } from './playback';

/** Окружение, у которого нет офлайн-хранилища: плеер работает как раньше. */
const NO_PLAYBACK: OfflinePlayback = {
  broken: () => undefined,
  has: () => false,
  prepare: () => undefined,
  resolve: () => null,
  subscribe: () => () => undefined,
  version: () => 0,
};

export type OfflineRuntime = {
  status: OfflineStatusStore;
  settings: OfflineSettingsStore;
  playback: OfflinePlayback;
  storage: OfflineStorage | null;
  /** Менеджер, пока он запущен (`startOffline`); команды интерфейса идут через него. */
  manager: OfflineManager | null;
};

/* v8 ignore start -- привязка к браузеру: воркер, OPFS, сеть; проверяется e2e (Chromium) */
/** Хранилище платформы: в PWA — OPFS; нативные оболочки (шаг 54) подставят свою реализацию. */
function createPlatformStorage(): OfflineStorage | null {
  if (platform() !== 'web') return null;
  const storage = createOpfsStorage(browserOpfsDeps());
  return storage.isSupported() ? storage : null;
}

const createPlatformDownloader = (): Downloader =>
  createWorkerDownloader(
    () => new Worker(new URL('./download.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  );

type NetworkInformation = { type?: string; addEventListener?(t: string, l: () => void): void; removeEventListener?(t: string, l: () => void): void };
const connection = () => (globalThis.navigator as { connection?: NetworkInformation } | undefined)?.connection;

function platformNetwork() {
  return {
    cellular: () => connection()?.type === 'cellular',
    online: isOnlineNow,
    subscribe(listener: () => void) {
      const unsocket = appData().socket.state.subscribe(listener);
      globalThis.addEventListener('online', listener);
      globalThis.addEventListener('offline', listener);
      connection()?.addEventListener?.('change', listener);
      return () => {
        unsocket();
        globalThis.removeEventListener('online', listener);
        globalThis.removeEventListener('offline', listener);
        connection()?.removeEventListener?.('change', listener);
      };
    },
  };
}
/* v8 ignore stop */

export function createOfflineRuntime(storage: OfflineStorage | null): OfflineRuntime {
  const status = createOfflineStatusStore(storage !== null);
  const rt: OfflineRuntime = {
    manager: null,
    playback: NO_PLAYBACK,
    settings: createOfflineSettings(),
    status,
    storage,
  };
  if (storage) {
    rt.playback = createOfflinePlayback({ markBroken: id => rt.manager?.markBroken(id), status, storage });
  }
  return rt;
}

let runtime: OfflineRuntime | null = null;

/** Офлайн-часть приложения (одна на вкладку): состояние, настройки, источник звука для плеера. */
export function offline(): OfflineRuntime {
  /* v8 ignore next -- создание окружения браузера */
  return (runtime ??= createOfflineRuntime(createPlatformStorage()));
}

/** Подмена окружения (тесты). */
export function installOffline(rt: OfflineRuntime | null): void {
  runtime = rt;
}

export type OfflineStartDeps = {
  downloader?: Downloader;
  tabs?: ReturnType<typeof createTabs<OfflineTabMessage>>;
  network?: Parameters<typeof createOfflineManager>[0]['network'];
  onStorageCleared?: (count: number) => void;
};

let clearedNotified = false;
/** Для тестов. */
export const resetClearedNotified = () => void (clearedNotified = false);
/** Система очистила скачанное (Safari, нехватка места): один toast за сессию; файлы докачаются сами. */
export function notifyStorageCleared(): void {
  if (clearedNotified) return;
  clearedNotified = true;
  toast.warning(tNow('offline.toast.cleared'), { id: 'offline-cleared' });
}

/**
 * Запускает менеджер (после входа). В окружении без офлайн-хранилища ничего не делает — `status.supported === false`.
 * Повторный вызов возвращает уже запущенный менеджер.
 */
export async function startOffline(over: OfflineStartDeps = {}): Promise<OfflineManager | null> {
  const rt = offline();
  if (!rt.storage) return null;
  if (rt.manager) return rt.manager;
  const data = appData();
  const manager = createOfflineManager({
    /* v8 ignore start -- значения по умолчанию из окружения браузера */
    downloader: over.downloader ?? createPlatformDownloader(),
    network: over.network ?? platformNetwork(),
    tabs: over.tabs ?? createTabs<OfflineTabMessage>({ name: 'nimbus-offline' }),
    /* v8 ignore stop */
    db: data.db,
    downloadUrl,
    headers: authHeaders,
    favoriteIds: () => data.selectors.favorites(data.library.getState()).map(t => t.id),
    libraryComplete: () => {
      const s = data.engine.status.getState().state;
      return s !== 'snapshot' && s !== 'hydrating';
    },
    library: data.library,
    onError: e => globalThis.reportError?.(e),
    onStorageCleared: over.onStorageCleared ?? notifyStorageCleared,
    onUnauthorized: notifyUnauthorized,
    settings: rt.settings,
    status: rt.status,
    storage: rt.storage,
  });
  rt.manager = manager;
  await manager.start();
  return manager;
}

/** Останавливает менеджер (выход, истёкшая сессия): загрузки прерываются, файлы остаются. */
export function stopOffline(): void {
  if (!runtime?.manager) return;
  runtime.manager.stop();
  runtime.manager = null;
}

/**
 * Выход со стиранием данных: останавливает менеджер и удаляет все офлайн-файлы, записи и закрепления
 * (работает и тогда, когда менеджер не запущен, — например, сессия истекла до запуска).
 */
export async function clearOffline(): Promise<void> {
  const rt = offline();
  if (!rt.storage) return;
  const manager = rt.manager;
  rt.manager = null;
  // Менеджер дожидается, пока воркер отпустит файлы, и только потом их удаляет.
  await manager?.clear().catch(e => globalThis.reportError?.(e));
  for (const name of await rt.storage.list().catch(() => [])) await rt.storage.remove(name).catch(() => undefined);
  // Основное соединение с базой выход мог уже закрыть: у очистки своё.
  const db = createDb();
  try {
    await db.offlineClear();
  } finally {
    db.close();
  }
  rt.status.setState({ ...createOfflineStatusStore(true).getState() }, true);
}
