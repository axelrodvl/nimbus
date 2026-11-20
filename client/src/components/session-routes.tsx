import { useEffect, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Spinner } from '@/components/ui/spinner';
import { safeNext, session, SPLASH_HINT_MS, useSession } from '@/lib/auth';
import { useT } from '@/lib/i18n/provider';
import { Login } from '@/screens/login';

/** Заставка до ответа о сессии; если ответ задерживается — подпись «Подключение к серверу…». */
function Splash() {
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SPLASH_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3" data-testid="splash" role="status">
      <Spinner className="size-6" />
      {slow && <p className="text-muted text-sm">{t('login.connecting')}</p>}
    </div>
  );
}

function Unreachable() {
  const t = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <ErrorState title={t('login.unavailable')}>
        <Button onClick={() => void session.start()} size="sm" variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    </div>
  );
}

/** Защита маршрутов: без входа (при включённой авторизации) — на `/login?next=<путь>`; иначе — оболочка. */
export function RequireSession() {
  const { authRequired, loggedOut, status, unreachable } = useSession(s => s);
  const location = useLocation();
  if (status === 'unknown') return unreachable ? <Unreachable /> : <Splash />;
  if (status === 'anonymous' && authRequired) {
    const path = location.pathname + location.search;
    const next = loggedOut || path === '/' ? '' : `?next=${encodeURIComponent(path)}`;
    return <Navigate replace to={`/login${next}`} />;
  }
  return <AppShell />;
}

/** `/login`: уже вошедшего — на `next` (или `/`). */
export function LoginRoute() {
  const status = useSession(s => s.status);
  const authRequired = useSession(s => s.authRequired);
  const [params] = useSearchParams();
  if (status === 'unknown') return <Splash />;
  if (status === 'authenticated' || !authRequired) return <Navigate replace to={safeNext(params.get('next'))} />;
  return <Login />;
}
