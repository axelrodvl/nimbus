'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, null);
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <label className="flex flex-col gap-2 text-sm font-medium">
        Токен доступа
        <input
          autoComplete="current-password"
          autoFocus
          className="border-divider dark:border-divider-dark focus-visible:ring-accent/40 rounded-lg border bg-white px-3 py-2 text-base focus-visible:ring-2 focus-visible:outline-none dark:bg-black"
          name="token"
          type="password"
        />
      </label>
      {state?.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <Button disabled={pending} type="submit">
        Войти
      </Button>
    </form>
  );
}
