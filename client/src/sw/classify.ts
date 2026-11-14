// Чистая классификация запросов для service worker: тестируется без воркера.
import { LOCALES } from '@/lib/i18n/config';
import { isApiPath, isArtistImagePath } from '@/lib/platform/urls';

export type RequestKind =
  /** Навигация по приложению: отвечается закэшированным `index.html`. */
  | 'shell'
  /** Обложка или фото артиста: cache-first. */
  | 'image'
  /** Необязательный словарь интерфейса: stale-while-revalidate. */
  | 'dictionary'
  /** Service worker не вмешивается. */
  | 'passthrough';

export type RequestInfo = {
  method: string;
  url: string;
  mode: string;
  destination: string;
  /** Есть заголовок `Range`. */
  range: boolean;
};

const COVER_HOSTS = ['coverartarchive.org', 'archive.org'];

// Словари кроме английского (он в основном бандле) — отдельные чанки `assets/<код>-<хэш>.js`.
const OPTIONAL = LOCALES.map(l => l.code).filter(c => c !== 'en');
const DICTIONARY = new RegExp(`^/assets/(${OPTIONAL.join('|')})-[\\w-]+\\.js$`);

/** Путь — чанк необязательного словаря интерфейса. */
export const isDictionaryPath = (pathname: string): boolean => DICTIONARY.test(pathname);

const isCoverHost = (host: string) => COVER_HOSTS.some(h => host === h || host.endsWith(`.${h}`));

export function classifyRequest(info: RequestInfo, origin: string): RequestKind {
  if (info.method !== 'GET' || info.range) return 'passthrough';
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return 'passthrough';
  }
  const sameOrigin = url.origin === origin;
  if (info.destination === 'image') {
    if (isCoverHost(url.hostname) || (sameOrigin && isArtistImagePath(url.pathname))) return 'image';
    return 'passthrough';
  }
  // Остальное под /api/ (в том числе поток аудио) — всегда сеть.
  if (sameOrigin && isApiPath(url.pathname)) return 'passthrough';
  if (info.mode === 'navigate') return sameOrigin ? 'shell' : 'passthrough';
  if (sameOrigin && isDictionaryPath(url.pathname)) return 'dictionary';
  return 'passthrough';
}
