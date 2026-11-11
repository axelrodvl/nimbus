'use client';

import { RefreshCw } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { retryAlbum } from '@/app/actions/sources';
import { Button } from '@/components/ui/button';
import { useT } from '@/providers/i18n-provider';

export function RetryAlbumButton({ albumId }: { albumId: number }) {
  const t = useT();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryAlbum(albumId);
          if (r.ok) toast.success(t('sources.retryStarted'));
          else toast.error(r.message);
        })
      }
    >
      <RefreshCw className={pending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
      {t('sources.retry')}
    </Button>
  );
}
