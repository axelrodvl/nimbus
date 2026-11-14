import { WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/provider';
import { useConnectionState, useOnline } from '@/lib/live/hooks';

const TOAST_ID = 'offline';

/** Постоянный toast, пока браузер офлайн или сокет закрыт; убирается при восстановлении связи. */
export function OfflineIndicator() {
  const online = useOnline();
  const socket = useConnectionState();
  const t = useT();
  const offline = !online || socket === 'closed';

  useEffect(() => {
    if (offline)
      toast.error(t('offline.toast'), { duration: Infinity, icon: <WifiOff className="size-4" />, id: TOAST_ID });
    else toast.dismiss(TOAST_ID);
  }, [offline, t]);
  useEffect(() => () => void toast.dismiss(TOAST_ID), []);

  return null;
}
