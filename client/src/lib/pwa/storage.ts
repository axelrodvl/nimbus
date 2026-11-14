// Постоянное хранилище: без `persist()` браузер вправе стереть IndexedDB/кэши (Safari — через 7 дней без визитов).

export const PERSIST_KEY = 'nimbus:pwa:persist-asked';

export type StorageManagerLike = {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
};

/** Один раз просит постоянное хранилище; повторные вызовы ничего не делают. Возвращает, было ли обращение. */
export async function requestPersistentStorage(
  manager: StorageManagerLike | undefined = globalThis.navigator?.storage,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage(),
): Promise<boolean> {
  if (!manager?.persist) return false;
  try {
    if (storage?.getItem(PERSIST_KEY)) return false;
    storage?.setItem(PERSIST_KEY, '1');
  } catch {
    // Без localStorage спросим ещё раз при следующем входе — безвредно.
  }
  try {
    await manager.persist();
  } catch {
    // Отказ браузера — не ошибка.
  }
  return true;
}

/** Просит постоянное хранилище по нажатию кнопки (жест пользователя); возвращает, стало ли оно постоянным. */
export async function requestPersistNow(
  manager: StorageManagerLike | undefined = globalThis.navigator?.storage,
): Promise<boolean> {
  try {
    return (await manager?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export type StorageInfo = { usage: number | null; quota: number | null; persistent: boolean };

/** Занятое место и признак постоянного хранилища для экрана «О приложении». */
export async function readStorageInfo(
  manager: StorageManagerLike | undefined = globalThis.navigator?.storage,
): Promise<StorageInfo> {
  let usage: number | null = null;
  let quota: number | null = null;
  let persistent = false;
  try {
    const estimate = await manager?.estimate?.();
    usage = estimate?.usage ?? null;
    quota = estimate?.quota ?? null;
    persistent = (await manager?.persisted?.()) ?? false;
  } catch {
    // Оставляем неизвестные значения.
  }
  return { persistent, quota, usage };
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
