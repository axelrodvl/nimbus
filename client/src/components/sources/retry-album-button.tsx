import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { retryAlbumSearch } from '@/lib/sources/actions';

/** «Повторить поиск» для альбома: треки без источника возвращаются в статус `adding`. */
export function RetryAlbumButton({ albumId }: { albumId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  return (
    <Button
      data-testid="retry-album"
      onClick={async () => {
        setPending(true);
        try {
          await retryAlbumSearch(albumId, { queryClient });
          toast.success(t('sources.retryStarted'));
        } catch (e) {
          toast.error(apiErrorMessage(e, t));
        } finally {
          setPending(false);
        }
      }}
      pending={pending}
      variant="secondary"
    >
      {pending ? null : <RefreshCw aria-hidden className="size-4" />}
      {t('sources.retry')}
    </Button>
  );
}
