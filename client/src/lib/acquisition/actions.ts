import type { QueryClient } from '@tanstack/react-query';
import {
  listAcquisition,
  pinAlbumRequest,
  retryAcquisitionRequest,
  retryJobRequest,
  setPausedAll,
  setTorrentPaused,
  unpinAlbumRequest,
  type AcquisitionItem,
  type DownloadsOverview,
} from '@/lib/api/acquisition';
import { appData } from '@/lib/app-data';
import type { Track } from '@/lib/db/types';
import type { LibraryStore, TrackPatch } from '@/lib/store/library';
import { restoreRows, snapshotRows, updateAlbumRow } from './cache';
import { ACQ_ROOT, downloadsKey, jobsKey, summaryKey } from './keys';
import { isActiveDownload } from './model';

/** Запросы раздела; в тестах подменяются. */
export type AcqRequests = {
  retry: typeof retryAcquisitionRequest;
  pinAlbum: typeof pinAlbumRequest;
  unpinAlbum: typeof unpinAlbumRequest;
  setPausedAll: typeof setPausedAll;
  setTorrentPaused: typeof setTorrentPaused;
  retryJob: typeof retryJobRequest;
  list: typeof listAcquisition;
};

const defaults: AcqRequests = {
  list: listAcquisition,
  pinAlbum: pinAlbumRequest,
  retry: retryAcquisitionRequest,
  retryJob: retryJobRequest,
  setPausedAll,
  setTorrentPaused,
  unpinAlbum: unpinAlbumRequest,
};

/** `library` — store библиотеки (по умолчанию — приложения): закрепление сразу видно экрану альбома. */
type Ctx = { queryClient: QueryClient; requests?: Partial<AcqRequests>; library?: LibraryStore };
const req = (ctx: Ctx): AcqRequests => ({ ...defaults, ...ctx.requests });

/** Сколько альбомов принимает один запрос повтора (ограничение сервера). */
export const RETRY_CHUNK = 5000;
/** Параллельность массового закрепления. */
export const PIN_CONCURRENCY = 4;

const refresh = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ACQ_ROOT });
};

/** Повторить поиск всех ненайденных (`missing` и `partial`); `resetDead` — перепроверить мёртвые раздачи. */
export async function retryMissing(opts: { resetDead: boolean }, ctx: Ctx): Promise<number> {
  const queued = await req(ctx).retry({ reset_dead: opts.resetDead, scope: 'missing' });
  refresh(ctx.queryClient);
  return queued;
}

/** Повторить поиск выбранных альбомов (кусками по `RETRY_CHUNK`). */
export async function retryAlbums(ids: readonly number[], opts: { resetDead: boolean }, ctx: Ctx): Promise<number> {
  let queued = 0;
  for (let i = 0; i < ids.length; i += RETRY_CHUNK) {
    queued += await req(ctx).retry({
      album_ids: ids.slice(i, i + RETRY_CHUNK) as number[],
      reset_dead: opts.resetDead,
      scope: 'albums',
    });
  }
  refresh(ctx.queryClient);
  return queued;
}

const pinned = (item: AcquisitionItem): AcquisitionItem => ({
  ...item,
  download: {
    bytes_done: item.download?.bytes_done ?? 0,
    bytes_total: item.download?.bytes_total ?? 0,
    down_bps: 0,
    peers: 0,
    pinned: true,
    state: 'queued',
  },
});

/**
 * Оптимистично меняет поля закрепления треков альбома в store (`fn` возвращает патч или `null` — трек не трогать);
 * возвращает откат. Откат возвращает только изменённые поля и только там, где они всё ещё равны оптимистичным:
 * событие или дельта, пришедшие за время запроса, не затираются. Настоящие значения затем приносит дельта.
 */
function patchAlbumTracks(ctx: Ctx, albumId: number, fn: (t: Track) => PinPatch | null): () => void {
  const lib = ctx.library ?? appData().library;
  const { tracks, tracksByAlbum } = lib.getState();
  const forward = new Map<number, PinPatch>();
  const back = new Map<number, PinPatch>();
  for (const id of tracksByAlbum.get(albumId) ?? []) {
    const t = tracks.get(id);
    const patch = t && fn(t);
    if (!t || !patch) continue;
    forward.set(id, patch);
    back.set(id, { pin: t.pin ?? null, pin_error: t.pin_error ?? null });
  }
  if (forward.size) lib.getState().patchTracks(forward);
  return () => {
    const current = lib.getState().tracks;
    const undo = new Map<number, TrackPatch>();
    for (const [id, patch] of forward) {
      const t = current.get(id);
      const was = back.get(id);
      if (!t || !was) continue;
      const fields: TrackPatch = {};
      if (patch.pin !== undefined && (t.pin ?? null) === patch.pin) fields.pin = was.pin;
      if (patch.pin_error !== undefined && (t.pin_error ?? null) === patch.pin_error) fields.pin_error = was.pin_error;
      if (Object.keys(fields).length) undo.set(id, fields);
    }
    if (undo.size) lib.getState().patchTracks(undo);
  };
}

type PinPatch = Pick<TrackPatch, 'pin' | 'pin_error'>;

/** Закрепление трека, как его ставит сервер (`pins::pin_tracks`): новое — по наличию источника, `failed` — заново в очередь. */
function pinPatch(t: Track): PinPatch | null {
  if (!t.in_library) return null;
  if (!t.pin) return { pin: t.status === 'found' || t.status === 'ready' ? 'queued' : 'waiting_source' };
  return t.pin === 'failed' ? { pin: 'queued', pin_error: null } : null;
}

/** Скачать альбом на сервер (закрепить). Оптимистично: строка сразу «в очереди»; при ошибке откат и повтор исключения. */
export async function pinAlbum(albumId: number, ctx: Ctx): Promise<void> {
  const snapshot = snapshotRows(ctx.queryClient);
  updateAlbumRow(ctx.queryClient, albumId, pinned);
  const rollback = patchAlbumTracks(ctx, albumId, pinPatch);
  try {
    await req(ctx).pinAlbum(albumId);
  } catch (e) {
    restoreRows(ctx.queryClient, snapshot);
    rollback();
    throw e;
  }
  refresh(ctx.queryClient);
}

/** Снять закрепление; `deleteFiles` — ещё и удалить файлы с сервера. Оптимистично, с откатом. */
export async function unpinAlbum(albumId: number, opts: { deleteFiles: boolean }, ctx: Ctx): Promise<void> {
  const snapshot = snapshotRows(ctx.queryClient);
  updateAlbumRow(ctx.queryClient, albumId, item => ({
    ...item,
    download: item.download ? { ...item.download, pinned: false, state: null } : item.download,
    ...(opts.deleteFiles && item.state === 'downloaded' ? { state: 'available' as const } : {}),
  }));
  // Сервер снимает закрепления со всех треков альбома. Статусы файлов (`ready` → `found` при удалении) не трогаем:
  // сервер удаляет не всё (файл нужен другому закреплению или играет) — точный итог принесёт дельта.
  const rollback = patchAlbumTracks(ctx, albumId, t => (t.pin ? { pin: null, pin_error: null } : null));
  try {
    await req(ctx).unpinAlbum(albumId, opts.deleteFiles);
  } catch (e) {
    restoreRows(ctx.queryClient, snapshot);
    rollback();
    throw e;
  }
  refresh(ctx.queryClient);
}

const setPausedCache = (qc: QueryClient, paused: boolean) =>
  qc.setQueryData<DownloadsOverview>(downloadsKey, d => (d ? { ...d, paused } : d));

/** Пауза всех загрузок / возобновление; состояние кнопки берётся из ответа сервера. */
export async function setAllPaused(paused: boolean, ctx: Ctx): Promise<boolean> {
  const now = await req(ctx).setPausedAll(paused);
  setPausedCache(ctx.queryClient, now);
  void ctx.queryClient.invalidateQueries({ queryKey: downloadsKey });
  return now;
}

export async function setTorrentPause(infoHash: string, paused: boolean, ctx: Ctx): Promise<void> {
  await req(ctx).setTorrentPaused(infoHash, paused);
  void ctx.queryClient.invalidateQueries({ queryKey: downloadsKey });
}

/** Повторить упавшую задачу: строка исчезает из списка сразу после ответа сервера. Бросает `ApiError` (409 и т. п.). */
export async function retryFailedJob(jobId: number, ctx: Ctx): Promise<void> {
  await req(ctx).retryJob(jobId);
  ctx.queryClient.setQueryData<{ jobs: { id: number }[] }>(jobsKey, data =>
    data ? { ...data, jobs: data.jobs.filter(j => j.id !== jobId) } : data,
  );
  void ctx.queryClient.invalidateQueries({ queryKey: jobsKey });
  void ctx.queryClient.invalidateQueries({ queryKey: summaryKey });
}

/** Все альбомы в состоянии `available`, которые ещё не закреплены (для «Скачать всё доступное»). */
export async function collectAvailableIds(ctx: Ctx, signal?: AbortSignal): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const page = await req(ctx).list({ cursor, states: ['available'] }, signal);
    for (const item of page.items) if (!isActiveDownload(item)) ids.push(item.album.id);
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return ids;
}

export type BulkPinResult = { done: number; failed: number };

/**
 * Закрепляет альбомы с ограничением параллельности (`PIN_CONCURRENCY`); `onProgress(done, total)` — после
 * каждого. Ошибка одного альбома не останавливает остальные: считается в `failed`.
 */
export async function pinAlbums(
  ids: readonly number[],
  ctx: Ctx,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkPinResult> {
  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      try {
        await req(ctx).pinAlbum(ids[i]);
      } catch {
        failed++;
      }
      done++;
      onProgress?.(done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PIN_CONCURRENCY, ids.length) }, worker));
  refresh(ctx.queryClient);
  return { done, failed };
}
