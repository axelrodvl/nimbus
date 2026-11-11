'use client';

import { WifiOff } from 'lucide-react';
import { useOffline } from 'next/offline';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useT } from '@/providers/i18n-provider';

export function OfflineIndicator() {
  const offline = useOffline();
  const t = useT();
  const toastId = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    if (offline) {
      toastId.current = toast.error(t('offline.toast'), {
        duration: Infinity,
        icon: <WifiOff className="h-4 w-4" />,
      });
    } else if (toastId.current !== undefined) {
      toast.dismiss(toastId.current);
      toastId.current = undefined;
    }
  }, [offline, t]);

  return null;
}
