import type { QueryClient } from '@tanstack/react-query';
import {
  addMagnetRequest,
  confirmSourceRequest,
  retryAlbumRequest,
  retryTrackRequest,
  setTrackSourceRequest,
  selectTorrentRequest,
  type RetryResult,
  type SourceChoice,
  type UseTorrentResult,
} from '@/lib/api/sources';
import { appData } from '@/lib/app-data';
import { offline } from '@/lib/offline';
import { player } from '@/lib/player';
import { albumTorrentsKey, trackSourcesKey } from './keys';

/** Запросы источников; в тестах подменяются. */
export type SourceRequests = {
  setSource: typeof setTrackSourceRequest;
  confirm: typeof confirmSourceRequest;
  retryTrack: typeof retryTrackRequest;
  retryAlbum: typeof retryAlbumRequest;
  addMagnet: typeof addMagnetRequest;
  selectTorrent: typeof selectTorrentRequest;
};

const defaults: SourceRequests = {
  addMagnet: addMagnetRequest,
  confirm: confirmSourceRequest,
  retryAlbum: retryAlbumRequest,
  retryTrack: retryTrackRequest,
  setSource: setTrackSourceRequest,
  selectTorrent: selectTorrentRequest,
};

type Ctx = {
  queryClient: QueryClient;
  requests?: SourceRequests;
  /** Удалить устаревшие копии треков на устройстве (по умолчанию — офлайн-менеджер, если он запущен). */
  markStale?: (trackIds: readonly number[]) => unknown;
};

const defaultMarkStale = (trackIds: readonly number[]) => offline().manager?.markStale(trackIds);

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

/**
 * Выбрать раздачу для всего альбома. Сервер переводит на неё найденные треки и удаляет свою копию прежних файлов;
 * здесь — удаляются копии этих треков на устройстве (закреплённые скачаются заново), играющий трек перезапускается
 * с новым источником. Бросает `ApiError`.
 */
export async function selectAlbumTorrent(
  albumId: number,
  torrentId: number,
  { queryClient, requests = defaults, markStale = defaultMarkStale }: Ctx,
): Promise<UseTorrentResult> {
  const result = await requests.selectTorrent(albumId, torrentId);
  void queryClient.invalidateQueries({ queryKey: ['track-sources'] });
  after(queryClient, albumId);
  for (const id of result.switched_track_ids) player().reloadTrack(id);
  if (result.switched_track_ids.length > 0) {
    // Переключение на сервере уже состоялось: сбой локального хранилища его не отменяет — сообщаем и идём дальше.
    try {
      await markStale(result.switched_track_ids);
    } catch (e) {
      globalThis.reportError?.(e);
    }
  }
  return result;
}
