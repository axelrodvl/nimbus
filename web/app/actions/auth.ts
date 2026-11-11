'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api/client';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, encodeToken } from '@/lib/auth';

export type LoginState = { error: string } | null;

async function isHttps() {
  const h = await headers();
  return h.get('x-forwarded-proto') === 'https';
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const token = String(formData.get('token') ?? '').trim();
  if (!token) return { error: 'Введите токен' };

  let status: number;
  try {
    const res = await api.POST('/api/auth/login', { body: { token } });
    status = res.response.status;
  } catch {
    return { error: 'Бэкенд недоступен, попробуйте позже' };
  }
  if (status === 401) return { error: 'Неверный токен' };
  if (status >= 400) return { error: 'Не удалось войти, попробуйте позже' };

  (await cookies()).set(AUTH_COOKIE, encodeToken(token), {
    httpOnly: true,
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
    secure: await isHttps(),
  });
  redirect('/');
}

export async function logout(): Promise<void> {
  (await cookies()).delete(AUTH_COOKIE);
  redirect('/login');
}
