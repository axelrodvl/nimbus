import { createContext, useContext } from 'react';
import type { SaveStatus } from '@/lib/settings/hooks';
import type { Patch, ServerSettings } from '@/lib/settings/types';

export type SectionApi = {
  settings: ServerSettings;
  /** Офлайн: поля сервера только для чтения. */
  readOnly: boolean;
  save: (patch: Patch) => Promise<boolean>;
  errors: Record<string, string>;
  status: SaveStatus;
};

const Ctx = createContext<SectionApi | null>(null);
export const SectionProvider = Ctx.Provider;

/** Настройки, сохранение и ошибки текущего раздела. */
export function useSection(): SectionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSection outside a settings section');
  return ctx;
}
