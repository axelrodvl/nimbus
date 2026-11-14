import { WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/provider';
import { useNetworkStatus } from '@/lib/live/hooks';

const TOAST_ID = 'offline';

/** Постоянный toast, пока нет сети или сервер недоступен; убирается при восстановлении связи. */
export function OfflineIndicator() {
  const status = useNetworkStatus();
  const t = useT();

  useEffect(() => {
    if (status === 'online') toast.dismiss(TOAST_ID);
    else
      toast.error(t(status === 'offline' ? 'offline.toast' : 'offline.serverToast'), {
        duration: Infinity,
        icon: <WifiOff className="size-4" />,
        id: TOAST_ID,
      });
  }, [status, t]);
  useEffect(() => () => void toast.dismiss(TOAST_ID), []);

  return null;
}
