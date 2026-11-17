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

/**
 * Добавляет на сервер альбомы для тестов плеера (артист 900): «Player Test» (альбом 903:
 * Song One → Broken Format [503 ffmpeg_missing] → Song Two → Song Three [ready] → Not Yet [adding]) и
 * «Transcode Test» (альбом 905, трек 9051 с перекодированием). `delayMs` — задержка потока по id трека.
 * Вызывать до открытия страницы.
 */
export async function seedPlayer(
  request: APIRequestContext,
  opts: { delayMs?: Record<number, number>; prefetchNext?: boolean } = {},
) {
  await request.post(`${MOCK}/__test/player`, { data: opts });
}

/**
 * Добавляет на сервер альбомы для офлайн-тестов (артист 920): «Offline Test» (923: треки 9231–9233) и
 * «Offline Transcode» (925: трек 9251 с перекодированием). `delayMs` — задержка потока по id трека,
 * `cut` — после скольких байт оборвать (один раз) ответ потока трека. Вызывать до открытия страницы.
 */
export async function seedOffline(
  request: APIRequestContext,
  opts: { delayMs?: Record<number, number>; cut?: Record<number, number> } = {},
) {
  await request.post(`${MOCK}/__test/offline`, { data: opts });
}

/** Добавляет альбом 913 «Sources Test» (артист 910): 9131 found, 9132 требует подтверждения, 9133 не найден. Вызывать до открытия страницы. */
export async function seedSources(request: APIRequestContext) {
  await request.post(`${MOCK}/__test/sources`);
}

/** Изменяющие запросы плейлистов отвечают `failStatus` и/или медленнее на `delayMs`. */
export async function setPlaylists(
  request: APIRequestContext,
  faults: { failStatus?: number | null; delayMs?: number },
) {
  await request.post(`${MOCK}/__test/playlists`, { data: faults });
}

/** Неисправности настроек: `failStatus` — `PUT /api/settings`, `providerTestOk: false` — проверка провайдера отклонена. */
export async function setSettingsFaults(
  request: APIRequestContext,
  faults: { failStatus?: number | null; providerTestOk?: boolean },
) {
  await request.post(`${MOCK}/__test/settings`, { data: faults });
}

/** Настройки сервера как они сохранены на моке (с секретами без маски). */
export async function mockSettings(request: APIRequestContext): Promise<Record<string, unknown>> {
  return (await request.get(`${MOCK}/__test/settings`)).json();
}

/**
 * Библиотека для сценариев «Загрузки» (артист 920): 921 не найден, 922 найден частично, 923 и 924 найдены (не скачаны),
 * 925 скачан, 926 ищется; два торрента движка и одна упавшая задача. `pinFail` — закрепление отвечает 500.
 * Вызывать до открытия страницы.
 */
export async function seedAcquisition(request: APIRequestContext, opts: { pinFail?: boolean; stuck?: boolean } = {}) {
  await request.post(`${MOCK}/__test/acquisition`, { data: opts });
}

/** Имитация загрузки альбома на сервер: прогресс в байтах (`bytes_done >= bytes_total` — завершено). */
export async function setProgress(request: APIRequestContext, albumId: number, bytesDone: number, bytesTotal?: number) {
  await request.post(`${MOCK}/__test/progress`, {
    data: { album_id: albumId, bytes_done: bytesDone, bytes_total: bytesTotal },
  });
}

/** Завершает поиск альбома: `adding` → `found` или `not_found`. */
export async function finishSearch(request: APIRequestContext, albumId: number, found: boolean) {
  await request.post(`${MOCK}/__test/search-result`, { data: { album_id: albumId, found } });
}
