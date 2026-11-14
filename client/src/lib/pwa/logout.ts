// Точка расширения выхода из учётной записи: модули с локальными данными регистрируют очистку
// (шаг 46 добавит `offline.clear()`).

export type LogoutHandler = () => Promise<void> | void;

const handlers = new Set<LogoutHandler>();

/** Регистрирует очистку при выходе; возвращает отписку. */
export function onLogout(handler: LogoutHandler): () => void {
  handlers.add(handler);
  return () => void handlers.delete(handler);
}

/** Вызывает все обработчики; сбой одного не мешает остальным. */
export async function runLogoutHandlers(): Promise<void> {
  await Promise.allSettled([...handlers].map(h => h()));
}
