import { Skeleton } from '@/components/ui/skeleton';
import { getHealth } from '@/lib/data/health';

export async function BackendStatus() {
  const health = await getHealth();
  return (
    <p className="text-muted text-xs">
      {health.ok ? `Бэкенд v${health.version} работает` : 'Бэкенд недоступен — запустите его (just backend)'}
    </p>
  );
}

export function BackendStatusSkeleton() {
  return <Skeleton className="h-4 w-48" />;
}
