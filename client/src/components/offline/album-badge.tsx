import { Check } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { useAlbumOffline, useOfflineSupported } from '@/lib/offline/hooks';

/** Отметка «скачан» в углу обложки карточки альбома (все треки на устройстве). */
export function AlbumOfflineBadge({ albumId }: { albumId: number }) {
  const t = useT();
  const supported = useOfflineSupported();
  const summary = useAlbumOffline(albumId);
  if (!supported || summary.state.kind !== 'done') return null;
  return (
    <span
      aria-label={t('offline.indicator.done')}
      className="bg-accent absolute top-5 left-5 flex size-6 items-center justify-center rounded-full text-white shadow-md"
      data-testid="album-offline-badge"
      role="img"
      title={t('offline.indicator.done')}
    >
      <Check aria-hidden className="size-3.5" strokeWidth={3} />
    </span>
  );
}
