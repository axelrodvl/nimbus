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

/** Путь принадлежит API бэкенда (`/api/…`): service worker такие запросы не кэширует. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/** Путь изображения, которое бэкенд отдаёт навсегда (`immutable`): фото артиста и обложки. */
export function isArtistImagePath(pathname: string): boolean {
  return pathname.startsWith('/api/artist-image/') || pathname.startsWith('/api/covers/');
}

/** Путь фото артиста (`/api/artist-image/…`): ответ 404 `no_image` service worker запоминает на сутки. */
export function isArtistPhotoPath(pathname: string): boolean {
  return pathname.startsWith('/api/artist-image/');
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

/** Обложка через дисковый кэш бэкенда (`/api/covers/{kind}/{mbid}/{size}`): отдаётся с `immutable`. */
export function coverUrl(kind: string, mbid: string, size: number): string {
  return apiUrl(`/api/covers/${kind}/${mbid}/${size}`);
}

/** Поток трека (`/api/tracks/{id}/stream`); `startSeconds` > 0 — смещение `?t=` для перекодируемых треков (без Range). */
export function streamUrl(trackId: number, startSeconds = 0): string {
  return apiUrl(`/api/tracks/${trackId}/stream${startSeconds > 0 ? `?t=${startSeconds.toFixed(3)}` : ''}`);
}

/** Полный файл трека для скачивания на устройство (`/api/tracks/{id}/stream?download=1`). */
export function downloadUrl(trackId: number): string {
  return apiUrl(`/api/tracks/${trackId}/stream?download=1`);
}
