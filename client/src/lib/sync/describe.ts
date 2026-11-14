import type { MessageKey } from '@/lib/i18n/messages';
import type { SyncStatus } from './status';

export type SyncView = {
  label: MessageKey;
  /** Подстановка для `{count}` (принятые строки снимка). */
  count?: number;
  tone: 'ok' | 'busy' | 'warn' | 'error';
  /** Показывать кнопку «Повторить». */
  retry: boolean;
};

/** Что показывать в боковой панели по состоянию движка синхронизации. */
export function describeSync(s: Pick<SyncStatus, 'state' | 'progress'>): SyncView {
  switch (s.state) {
    case 'snapshot':
      return { count: s.progress?.received ?? 0, label: 'sync.loading', retry: false, tone: 'busy' };
    case 'hydrating':
    case 'delta':
      return { label: 'sync.syncing', retry: false, tone: 'busy' };
    case 'offline':
      return { label: 'sync.offline', retry: true, tone: 'warn' };
    case 'error':
      return { label: 'sync.error', retry: true, tone: 'error' };
    case 'idle':
    case 'live':
    default:
      return { label: 'sync.live', retry: false, tone: 'ok' };
  }
}
