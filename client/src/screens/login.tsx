import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { MusicNote } from '@/components/ui/music-note';
import { ApiError } from '@/lib/api/errors';
import { session } from '@/lib/auth';
import { useT } from '@/lib/i18n/provider';
import { useTitle } from '@/lib/nav/use-title';

/** Экран входа по токену. После успеха маршрут `/login` сам переводит на `next` (статус сессии меняется). */
export function Login() {
  const t = useT();
  useTitle(t('login.title'));
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!value) return setError(t('login.empty'));
    setPending(true);
    setError(null);
    try {
      await session.login(value);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError(t('login.invalid'));
      else if (err instanceof ApiError && err.status === 0) setError(t('login.unavailable'));
      else setError(t('login.failed'));
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <div className="text-accent inline-flex items-center gap-2 text-2xl font-bold tracking-tight">
        <MusicNote className="text-accent" size={32} />
        <span>Nimbus</span>
      </div>
      <h1 className="sr-only">{t('login.title')}</h1>
      <form className="flex w-full max-w-sm flex-col gap-4" noValidate onSubmit={e => void submit(e)}>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {t('login.token')}
          <input
            autoComplete="current-password"
            autoFocus
            className="border-divider dark:border-divider-dark focus-visible:ring-accent/40 rounded-lg border bg-white px-3 py-2 text-base focus-visible:ring-2 focus-visible:outline-none dark:bg-black"
            name="token"
            onChange={e => setToken(e.target.value)}
            type="password"
            value={token}
          />
        </label>
        {error ? (
          <p className="text-danger text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Button pending={pending} type="submit">
          {t('login.submit')}
        </Button>
      </form>
    </main>
  );
}
