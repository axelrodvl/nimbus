import { z } from 'zod';

const schema = z.object({
  // Адрес бэкенда для серверного кода (Server Components, Server Functions).
  BACKEND_URL: z.url().default('http://localhost:8080'),
  // Адрес бэкенда для браузера (stream, WebSocket, клиентские fetch).
  NEXT_PUBLIC_BACKEND_URL: z.url().default('http://localhost:8080'),
});

// Значения читаются явно: Next.js подставляет NEXT_PUBLIC_* в клиентский бандл только при буквальном
// обращении к `process.env.NEXT_PUBLIC_*`. Пустая строка считается «не задано».
const env = schema.parse({
  BACKEND_URL: process.env.BACKEND_URL || undefined,
  NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL || undefined,
});

const trim = (url: string) => url.replace(/\/+$/, '');

export const serverBackendUrl = trim(env.BACKEND_URL);
export const publicBackendUrl = trim(env.NEXT_PUBLIC_BACKEND_URL);
