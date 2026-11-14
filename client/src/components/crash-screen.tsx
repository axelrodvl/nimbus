import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';

/** Стирает локальную базу и перезагружает страницу: данные приходят заново снимком. */
export async function resetLocalData(): Promise<void> {
  await appData()
    .db.clear()
    .catch(() => undefined);
  globalThis.location.reload();
}

/** Экран неустранимой ошибки: перезагрузить или сбросить локальные данные (на случай битой базы). */
export function CrashScreen() {
  const t = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <ErrorState body={t('error.page.body')} title={t('error.page.title')}>
        <div className="flex gap-2">
          <Button onClick={() => globalThis.location.reload()} size="sm">
            {t('shell.reload')}
          </Button>
          <Button onClick={() => void resetLocalData()} size="sm" variant="secondary">
            {t('shell.resetData')}
          </Button>
        </div>
      </ErrorState>
    </div>
  );
}
