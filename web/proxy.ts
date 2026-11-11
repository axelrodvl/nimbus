import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, encodeToken } from '@/lib/auth';

// Если задан NIMBUS_API_TOKEN, без валидной cookie `nimbus_token` пускаем только на /login.
// (Cookie ставит Server Function `login` после проверки токена бэкендом; здесь сверяем с токеном
// из окружения веб-сервера, поэтому подделать cookie нельзя, не зная токен.)
export function proxy(request: NextRequest) {
  const token = process.env.NIMBUS_API_TOKEN?.trim();
  if (!token) return NextResponse.next();

  if (request.cookies.get(AUTH_COOKIE)?.value === encodeToken(token)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|icon|apple-touch-icon|manifest.webmanifest|favicon.ico|robots.txt|api/).*)'],
};
