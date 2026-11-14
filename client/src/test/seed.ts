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

/** Store синглтона, ещё не гидрированный (экраны показывают skeleton). */
export function seedNothing(): void {
  appData().library.getState().reset();
  appData().live.getState().clear();
}
