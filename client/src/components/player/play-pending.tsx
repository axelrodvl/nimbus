import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import { playRemoteApp, SLOW_PENDING_MS, usePlayPendingState } from '@/lib/search/play-remote';
import { useAlbumProgress } from '@/lib/store/hooks';

/**
 * Глобальный индикатор «ищем источник» над плеером: виден на любом экране, пока трек или альбом из поиска ждёт
 * источника. Показывает стадию (поиск раздач / проверка N из M), через `SLOW_PENDING_MS` — что это может занять
 * несколько минут, и даёт отменить ожидание.
 */
export function PlayPending() {
  const t = useT();
  const pending = usePlayPendingState();
  const progress = useAlbumProgress(pending?.albumId ?? -1);
  // «Дольше обычного» помним по запросу: у нового ожидания флаг сбрасывается сам, без setState в эффекте.
  const [slowFor, setSlowFor] = useState<unknown>(null);
  const request = pending?.request;
  const startedAt = pending?.startedAt ?? 0;
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => setSlowFor(request), Math.max(0, startedAt + SLOW_PENDING_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [request, startedAt]);
  const slow = slowFor !== null && slowFor === request;
  if (!pending) return null;
  const stage = pending.retrying
    ? t('play.mbRetry')
    : progress?.stage === 'verifying' && progress.total > 0
      ? t('status.label.verifying', { done: progress.done, total: progress.total })
      : t('status.label.adding');
  return (
    <div
      aria-live="polite"
      className="border-divider dark:border-divider-dark flex shrink-0 items-center gap-3 border-t bg-white px-5 py-2 text-xs sm:px-4 dark:bg-[#181818]"
      data-testid="play-pending"
      role="status"
    >
      <Spinner className="size-4 shrink-0" />
      <div className="mx-auto flex max-w-7xl min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
        <span className="truncate font-medium text-black dark:text-white">
          {t('play.waitingShort')} · {pending.request.title}
        </span>
        <span className="text-muted truncate" data-testid="play-pending-stage">
          {stage}
          {slow ? ` · ${t('play.slowHint')}` : ''}
        </span>
      </div>
      <button
        className="text-accent-fg focus-visible:ring-accent/40 shrink-0 rounded px-1 font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        data-testid="play-pending-cancel"
        onClick={() => playRemoteApp().userCancel()}
        type="button"
      >
        {t('common.cancel')}
      </button>
    </div>
  );
}
