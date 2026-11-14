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

/** Заменяет данные мока большой библиотекой (скорость и виртуализация); клиентам нужна свежая загрузка страницы. */
export async function seedMock(request: APIRequestContext, q: { artists: number; albums: number; tracks: number }) {
  await request.post(`${MOCK}/__test/seed?artists=${q.artists}&albums=${q.albums}&tracks=${q.tracks}`);
}

/** Задаёт статус импорта артиста для `GET /api/artists/{id}` (`null` — импорта нет). */
export async function setImport(request: APIRequestContext, id: number, status: Record<string, unknown> | null) {
  await request.post(`${MOCK}/__test/import`, { data: { id, status } });
}

/** `DELETE /api/library/*` отвечает 500, пока включено. */
export async function failDelete(request: APIRequestContext, fail: boolean) {
  await request.post(`${MOCK}/__test/fail-delete`, { data: { fail } });
}

/** Неисправности и задержки поиска: `delayMs`/`failStatus` — `GET /api/search`, `addDelayMs`/`addFailStatus` — `POST /api/library`. */
export async function setSearch(
  request: APIRequestContext,
  faults: { delayMs?: number; failStatus?: number | null; addDelayMs?: number; addFailStatus?: number | null },
) {
  await request.post(`${MOCK}/__test/search`, { data: faults });
}
