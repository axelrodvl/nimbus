'use client';

import { Loader2 } from 'lucide-react';
import { useAlbumProgress } from '@/providers/live-library-provider';

// Live-прогресс поиска/проверки раздач альбома (из событий `job.progress`).
export function AlbumProgress({ albumId }: { albumId: number }) {
  const progress = useAlbumProgress(albumId);
  if (!progress) return null;
  return (
    <p className="text-muted flex items-center gap-2 text-sm" data-testid="album-progress" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {progress.stage === 'verifying' && progress.total > 0
        ? `Проверяем раздачи ${progress.done}/${progress.total}`
        : 'Ищем раздачи…'}
    </p>
  );
}
