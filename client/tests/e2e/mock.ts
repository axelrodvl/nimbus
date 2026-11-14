import type { APIRequestContext } from '@playwright/test';

const MOCK = `http://localhost:${process.env.MOCK_BACKEND_PORT ?? 4011}`;

/** Сбрасывает состояние мока бэкенда (данные, авторизация, журнал запросов). */
export async function resetMock(
  request: APIRequestContext,
  opts: { authRequired?: boolean; snapshotDelayMs?: number } = {},
) {
  await request.post(`${MOCK}/__test/reset`, { data: opts });
}

/** Журнал запросов к `/api/*`, принятых моком с последнего сброса. */
export async function mockLog(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${MOCK}/__test/log`);
  return ((await res.json()) as { log: string[] }).log;
}

/** Рассылает событие всем подключённым по WebSocket клиентам. */
export async function emit(request: APIRequestContext, event: unknown) {
  await request.post(`${MOCK}/__test/emit`, { data: event });
}

/** Меняет данные синхронизации на сервере (клиентам уходит `sync.poke`). */
export async function mutate(request: APIRequestContext, body: unknown) {
  await request.post(`${MOCK}/__test/mutate`, { data: body });
}

/** Рвёт все WebSocket-соединения; `block` — не пускать новые, пока не вызвано с `false`. */
export async function dropWs(request: APIRequestContext, block: boolean) {
  await request.post(`${MOCK}/__test/ws`, { data: { block } });
}
