import { appData } from '@/lib/app-data';
import type { LibraryRows } from '@/lib/db/types';
import { emptyRows } from '@/lib/db/types';

/** Сбрасывает store и live-состояние синглтона и загружает строки (экраны считаются гидрированными). */
export function seed(rows: Partial<LibraryRows> = {}): void {
  const { library, live } = appData();
  library.getState().reset();
  live.getState().clear();
  library.getState().hydrate({ ...emptyRows(), ...rows });
}

/** Только фаза 1 гидрации: артисты, альбомы, плейлисты есть, треки ещё не прочитаны (`tracksHydrated = false`). */
export function seedPhaseOne(rows: Partial<LibraryRows> = {}): void {
  const { library, live } = appData();
  library.getState().reset();
  live.getState().clear();
  const { tracks: _tracks, ...core } = { ...emptyRows(), ...rows };
  library.getState().hydrate(core);
}

/** Store синглтона, ещё не гидрированный (экраны показывают skeleton). */
export function seedNothing(): void {
  appData().library.getState().reset();
  appData().live.getState().clear();
}
