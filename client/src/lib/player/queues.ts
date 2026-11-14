import { appData } from '@/lib/app-data';
import type { TrackView } from '@/lib/store/selectors';
import { canPlay, toPlayerTrack, type PlayerTrack } from './track';

/** Очередь из треков: только доступные для воспроизведения, порядок сохраняется. */
export function playableQueue(views: readonly TrackView[]): PlayerTrack[] {
  return views.filter(canPlay).map(toPlayerTrack);
}

/**
 * Очередь по списку id (экран со списком треков): читается из store в момент запуска, а не на каждый рендер
 * (в библиотеке может быть десятки тысяч треков).
 */
export function queueFromIds(ids: readonly number[]): PlayerTrack[] {
  const { library, selectors } = appData();
  const state = library.getState();
  const out: PlayerTrack[] = [];
  for (const id of ids) {
    const view = selectors.trackView(state, id);
    if (view && canPlay(view)) out.push(toPlayerTrack(view));
  }
  return out;
}
