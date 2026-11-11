import { Skeleton } from '@/components/ui/skeleton';
import { getHealth } from '@/lib/data/health';
import { getT } from '@/lib/i18n/server';

export async function BackendStatus() {
  const t = await getT();
  const health = await getHealth();
  return (
    <p className="text-muted text-xs">
      {health.ok ? t('backend.ok', { version: health.version }) : t('backend.down')}
    </p>
  );
}

export function BackendStatusSkeleton() {
  return <Skeleton className="h-4 w-48" />;
}
