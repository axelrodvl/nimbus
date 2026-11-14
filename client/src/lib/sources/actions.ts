import type { QueryClient } from '@tanstack/react-query';
import {
  addMagnetRequest,
  confirmSourceRequest,
  retryAlbumRequest,
  retryTrackRequest,
  setTrackSourceRequest,
  type RetryResult,
  type SourceChoice,
} from '@/lib/api/sources';
import { appData } from '@/lib/app-data';
import { player } from '@/lib/player';
import { albumTorrentsKey, trackSourcesKey } from './keys';

/** Запросы источников; в тестах подменяются. */
export type SourceRequests = {
  setSource: typeof setTrackSourceRequest;
  confirm: typeof confirmSourceRequest;
  retryTrack: typeof retryTrackRequest;
  retryAlbum: typeof retryAlbumRequest;
  addMagnet: typeof addMagnetRequest;
};

const defaults: SourceRequests = {
  addMagnet: addMagnetRequest,
  confirm: confirmSourceRequest,
  retryAlbum: retryAlbumRequest,
  retryTrack: retryTrackRequest,
  setSource: setTrackSourceRequest,
};

type Ctx = { queryClient: QueryClient; requests?: SourceRequests };

const after = (queryClient: QueryClient, albumId: number, trackId?: number) => {
  void queryClient.invalidateQueries({ queryKey: albumTorrentsKey(albumId) });
  if (trackId !== undefined) void queryClient.invalidateQueries({ queryKey: trackSourcesKey(trackId) });
  appData().engine.requestSync('sources');
};

/**
 * Выбрать источник трека. Источники не синхронизируются, поэтому мутация не оптимистична: запрос → инвалидация
 * запросов и синхронизация (статус и `needs_confirmation` трека придут дельтой). Если трек сейчас играет, поток
 * перезапускается с текущей позиции. Бросает `ApiError`.
 */
export async function chooseTrackSource(
  trackId: number,
  albumId: number,
  choice: SourceChoice,
  { queryClient, requests = defaults }: Ctx,
): Promise<void> {
  await requests.setSource(trackId, choice);
  after(queryClient, albumId, trackId);
  player().reloadTrack(trackId);
}

/** Подтвердить сомнительный источник. */
export async function confirmTrackSource(
  trackId: number,
  albumId: number,
  sourceId: number,
  { queryClient, requests = defaults }: Ctx,
): Promise<void> {
  await requests.confirm(trackId, sourceId);
  after(queryClient, albumId, trackId);
}

/** Повторить поиск источников для трека. */
export async function retryTrackSearch(
  trackId: number,
  albumId: number,
  { queryClient, requests = defaults }: Ctx,
): Promise<RetryResult> {
  const result = await requests.retryTrack(trackId);
  after(queryClient, albumId, trackId);
  return result;
}

/** Повторить поиск источников для альбома. */
export async function retryAlbumSearch(
  albumId: number,
  { queryClient, requests = defaults }: Ctx,
): Promise<RetryResult> {
  const result = await requests.retryAlbum(albumId);
  after(queryClient, albumId);
  return result;
}

/** Добавить свою раздачу к альбому. */
export async function addAlbumMagnet(albumId: number, magnet: string, { queryClient, requests = defaults }: Ctx) {
  const result = await requests.addMagnet(albumId, magnet.trim());
  after(queryClient, albumId);
  return result;
}
