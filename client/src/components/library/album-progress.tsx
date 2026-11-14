import { Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import type { AlbumProgressInfo } from '@/lib/library/status';

/** Live-прогресс поиска и проверки раздач альбома (из событий `job.progress`); без прогресса — ничего. */
export function AlbumProgress({ progress }: { progress: AlbumProgressInfo | undefined }) {
  const t = useT();
  if (!progress) return null;
  return (
    <p className="text-muted flex items-center gap-2 text-sm" data-testid="album-progress" role="status">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {progress.stage === 'verifying' && progress.total > 0
        ? t('status.label.verifying', { done: progress.done, total: progress.total })
        : t('status.label.adding')}
    </p>
  );
}
