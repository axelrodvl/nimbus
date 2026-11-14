import { createApiClient, onUnauthorized } from '@/lib/api/client';
import { createSyncApi, type SyncApi } from '@/lib/api/sync';
import { postPlayed } from '@/lib/api/tracks';
import { createDb, type Db } from '@/lib/db';
import { createLibraryStore } from '@/lib/store/library';
import { createLiveSocket, type SocketLike } from '@/lib/live/socket';
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
  createSocket?: (url: string) => SocketLike;
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
  // Каждое событие — в движок (раньше подписчиков); при (пере)подключении — дельта.
  const socket = createLiveSocket({
    createSocket: deps.createSocket,
    onEvent: e => engine.handleEvent(e),
    onOpen: () => engine.requestSync('ws-open'),
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
      socket.start();
    },
    db,
    engine,
    library,
    live,
    mutations,
    socket,
    selectors,
    shutdown() {
      socket.stop();
      mutations.stop();
      engine.stop();
      db.close();
    },
  };
}

export type AppData = ReturnType<typeof createAppData>;

let instance: AppData | null = null;

/** Синглтон приложения (создаётся при первом обращении; `bootstrap()` вызывает сессия после входа). */
export function appData(): AppData {
  // База закрыта другой вкладкой (смена схемы): текущее состояние непригодно — перезагружаем страницу.
  instance ??= createAppData({
    db: createDb({ onClosed: () => globalThis.location?.reload() }),
    onUnauthorized: () => unauthorizedBridge(),
  });
  return instance;
}

/**
 * Останавливает приложение и забывает синглтон: следующий `appData()` создаст чистый экземпляр
 * (с повторным чтением IndexedDB). `clearData` стирает локальную базу (выход из аккаунта).
 */
export async function resetAppData(clearData: boolean): Promise<void> {
  const current = instance;
  instance = null;
  const db = current?.db ?? (clearData ? createDb() : null);
  if (current) {
    current.socket.stop();
    current.mutations.stop();
    current.engine.stop();
  }
  if (clearData) await db?.clear().catch(() => undefined);
  db?.close();
}

// 401 в движке и в обычных запросах идут в один обработчик (его ставит оболочка через `onUnauthorized`).
let unauthorizedHandler: (() => void) | null = null;
function unauthorizedBridge() {
  unauthorizedHandler?.();
}

/** Сообщает о потере авторизации тем же путём, что и 401 в обычных запросах (для скачивания офлайн-треков). */
export function notifyUnauthorized(): void {
  unauthorizedBridge();
}

/** Подключает обработчик потери авторизации и для движка, и для всех запросов API. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
  onUnauthorized(handler);
}
