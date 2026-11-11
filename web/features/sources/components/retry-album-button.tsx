'use client';

import { RefreshCw } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { retryAlbum } from '@/app/actions/sources';
import { Button } from '@/components/ui/button';

export function RetryAlbumButton({ albumId }: { albumId: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryAlbum(albumId);
          if (r.ok) toast.success('Поиск запущен заново');
          else toast.error(r.message);
        })
      }
    >
      <RefreshCw className={pending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
      Повторить поиск
    </Button>
  );
}
