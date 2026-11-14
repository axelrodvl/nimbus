import { createApiClient, onUnauthorized } from '@/lib/api/client';
import { createSyncApi, type SyncApi } from '@/lib/api/sync';
import { postPlayed } from '@/lib/api/tracks';
import { createDb, type Db } from '@/lib/db';
import { createLibraryStore } from '@/lib/store/library';
import { createLiveStore } from '@/lib/store/live';
import { createMutations } from '@/lib/store/mutations';
import { createSelectors } from '@/lib/store/selectors';
import { createSyncEngine } from '@/lib/sync/engine';
import { createTabs, type Tabs } from '@/lib/sync/tabs';

export type AppDataDeps = {
  db?: Db;
  syncApi?: SyncApi;
  tabs?: Tabs;
  postPlayed?: (trackId: number) => Promise<unknown>;
  onUnauthorized?: () => void;
};

/** Собирает данные приложения: база, store, движок синхронизации, мутации. В тестах всё создаётся заново. */
export function createAppData(deps: AppDataDeps = {}) {
  const client = createApiClient();
  const db = deps.db ?? createDb();
  const library = createLibraryStore();
  const live = createLiveStore();
  const selectors = createSelectors();
  const engine = createSyncEngine({
    api: deps.syncApi ?? createSyncApi(client),
    db,
    live,
    onUnauthorized: () => (deps.onUnauthorized ?? (() => undefined))(),
    store: library,
    tabs: deps.tabs ?? createTabs(),
  });
  const mutations = createMutations({
    db,
    postPlayed: deps.postPlayed ?? (id => postPlayed(id, client)),
    requestSync: reason => engine.requestSync(reason),
    store: library,
  });

  return {
    /** Запуск: данные из IndexedDB → экраны, затем синхронизация; отправка накопленного outbox. */
    async bootstrap() {
      await engine.start();
      mutations.start();
    },
    db,
    engine,
    library,
    live,
    mutations,
    selectors,
    shutdown() {
      mutations.stop();
      engine.stop();
      db.close();
    },
  };
}

export type AppData = ReturnType<typeof createAppData>;

let instance: AppData | null = null;

/** Синглтон приложения (создаётся при первом обращении; `main.tsx` подключит `bootstrap()` на шаге 38). */
export function appData(): AppData {
  instance ??= createAppData({ onUnauthorized: () => unauthorizedBridge() });
  return instance;
}

// 401 в движке и в обычных запросах идут в один обработчик (его ставит оболочка через `onUnauthorized`).
let unauthorizedHandler: (() => void) | null = null;
function unauthorizedBridge() {
  unauthorizedHandler?.();
}

/** Подключает обработчик потери авторизации и для движка, и для всех запросов API. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
  onUnauthorized(handler);
}
