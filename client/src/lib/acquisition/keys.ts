import type { AcquisitionState } from '@/lib/api/acquisition';

/** Корень ключей TanStack Query раздела: инвалидация корня обновляет всё. */
export const ACQ_ROOT = ['acquisition'] as const;
export const summaryKey = [...ACQ_ROOT, 'summary'] as const;
export const listKey = (states: readonly AcquisitionState[]) => [...ACQ_ROOT, 'list', states.join(',')] as const;
export const LIST_ROOT = [...ACQ_ROOT, 'list'] as const;
export const downloadsKey = [...ACQ_ROOT, 'downloads'] as const;
export const jobsKey = [...ACQ_ROOT, 'jobs'] as const;
export const invariantsKey = [...ACQ_ROOT, 'invariants'] as const;

/** Серия событий — один перезапрос. */
export const ACQ_REFRESH_DEBOUNCE_MS = 1000;
/** Опрос торрентов движка (событий у него нет) — только пока открыта вкладка «Торренты». */
export const ENGINE_POLL_MS = 2000;
/** Сколько загруженных страниц перезапрашивать при обновлении списка; дальше — только первые. */
export const MAX_REFETCH_PAGES = 3;
