import { appData } from '@/lib/app-data';
import type { TrackView } from '@/lib/store/selectors';

/** Представление трека из store синглтона (для тестов). */
export function selectorsFor(id: number): TrackView | undefined {
  const { library, selectors } = appData();
  return selectors.trackView(library.getState(), id);
}
