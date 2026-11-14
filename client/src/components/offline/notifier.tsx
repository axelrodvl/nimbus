import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { appData } from '@/lib/app-data';
import { tNow } from '@/lib/i18n/t-now';
import { offline } from '@/lib/offline';
import { useOfflineSupported } from '@/lib/offline/hooks';
import { createOfflineNotifier } from '@/lib/offline/notify';

/** Подключает toast-уведомления офлайн-движка (завершение закрепления, нехватка места, ошибки). Ничего не рисует. */
export function OfflineNotifier() {
  const supported = useOfflineSupported();
  const navigate = useNavigate();
  useEffect(() => {
    if (!supported) return;
    const data = appData();
    const notifier = createOfflineNotifier({
      favoriteIds: () => data.selectors.favorites(data.library.getState()).map(t => t.id),
      library: data.library,
      openSettings: () => void navigate('/settings/offline'),
      status: offline().status,
      t: tNow,
      toast,
    });
    return () => notifier.dispose();
  }, [supported, navigate]);
  return null;
}
