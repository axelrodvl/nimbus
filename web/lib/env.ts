import { z } from 'zod';

const schema = z.object({
  // Адрес бэкенда для серверного кода (Server Components, Server Functions).
  BACKEND_URL: z.url().default('http://localhost:8080'),
  // Адрес бэкенда для браузера (stream, WebSocket, клиентские fetch).
  // Пустая строка — относительные URL (тот же origin, например за reverse proxy).
  NEXT_PUBLIC_BACKEND_URL: z.union([z.literal(''), z.url()]).default('http://localhost:8080'),
});

// Значения читаются явно: Next.js подставляет NEXT_PUBLIC_* в клиентский бандл только при буквальном
// обращении к `process.env.NEXT_PUBLIC_*`. Для BACKEND_URL пустая строка считается «не задано»;
// для NEXT_PUBLIC_BACKEND_URL пустая строка — осознанный выбор «тот же origin».
const env = schema.parse({
  BACKEND_URL: process.env.BACKEND_URL || undefined,
  NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
});

const trim = (url: string) => url.replace(/\/+$/, '');

export const serverBackendUrl = trim(env.BACKEND_URL);
export const publicBackendUrl = trim(env.NEXT_PUBLIC_BACKEND_URL);
