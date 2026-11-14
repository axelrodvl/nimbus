// Единственное место, где строятся адреса бэкенда (HTTP, WebSocket, поток, картинки, `download=1`).
// Всё остальное получает адрес отсюда: литерал `'/api/…'` вне lib/platform и lib/api запрещён линтом.

const trim = (url: string) => url.replace(/\/+$/, '');

let base = trim(import.meta.env.VITE_API_BASE ?? '');

/** Базовый адрес бэкенда: пусто — тот же origin (PWA), иначе абсолютный (`https://music.example.com`). */
export function apiBase(): string {
  return base;
}

/** Задаёт базовый адрес бэкенда (нативная оболочка после выбора сервера; тесты). */
export function setApiBase(url: string): void {
  base = trim(url);
}

/** HTTP-адрес эндпоинта бэкенда: `apiUrl('/api/health')`. */
export function apiUrl(path: string): string {
  return `${base}${path}`;
}

/** Адрес WebSocket: схема `ws`/`wss` — от абсолютной базы, иначе от `location`. */
export function wsUrl(path: string): string {
  if (base) return `${base.replace(/^http/, 'ws')}${path}`;
  const { host, protocol } = globalThis.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${path}`;
}

/** Адрес live-сокета событий (`/api/ws`). */
export function liveSocketUrl(): string {
  return wsUrl('/api/ws');
}

/** Фото артиста (`/api/artist-image/{mbid}`): бэкенд ищет его в Wikidata/Commons, затем в Deezer. */
export function artistImageUrl(mbid: string): string {
  return apiUrl(`/api/artist-image/${mbid}`);
}
