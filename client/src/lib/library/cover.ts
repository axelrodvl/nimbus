import { coverUrl } from '@/lib/platform/urls';
import { IMAGE_CACHE } from '@/sw/cache';

/** Размеры миниатюр Cover Art Archive: карточки — 250, шапка альбома — 500. */
export type CoverThumb = 250 | 500;

const CAA_FRONT = /^https?:\/\/coverartarchive\.org\/(release-group|release)\/([0-9a-f-]{36})\/front(-\d+)?$/i;

/**
 * Адрес обложки под размер места. Бэкенд отдаёт адреса Cover Art Archive вида `…/front[-N]`; в `<img>` идёт адрес
 * нашего бэкенда (`/api/covers/{kind}/{mbid}/{size}`): он скачивает обложку один раз и отдаёт с `immutable`, а у archive.org
 * нет заголовков кэширования и цепочка редиректов — браузер перезагружал бы каждую картинку. Любой другой адрес — как есть.
 */
export function coverSrc(url: string | null | undefined, thumb: CoverThumb): string | null {
  if (!url) return null;
  const m = CAA_FRONT.exec(url);
  return m ? coverUrl(m[1], m[2], thumb) : url;
}

const shown = new Set<string>();
/** Сколько адресов помним: на 60 000 треков обложек — тысячи, но память под строки ничтожна. */
const MAX_SHOWN = 20000;

/** Картинка загрузилась и была показана: при следующем монтировании она уже в кэше браузера. */
export function markImageShown(url: string): void {
  shown.delete(url); // свежая — в конец, вытесняются давно показанные
  shown.add(url);
  if (shown.size > MAX_SHOWN) shown.delete(shown.values().next().value as string);
}

const broken = new Set<string>();

/** Картинка не загрузилась (нет обложки): при повторном монтировании сразу заглушка, без вспышки «плашка → градиент». */
export function markImageBroken(url: string): void {
  broken.add(url);
}

export function isImageBroken(url: string): boolean {
  return broken.has(url);
}

/**
 * Атрибуты `<img>` по тому, видели ли картинку в этой сессии. Уже показанная (вернулись «назад» на экран) —
 * без ленивой загрузки и с синхронным декодированием: из кэша она рисуется в первом же кадре, а не пустой плашкой
 * на кадр-другой. Новая — лениво и асинхронно, чтобы не тормозить появление экрана.
 */
export function imageLoading(url: string, priority = false): { loading: 'eager' | 'lazy'; decoding: 'sync' | 'async' } {
  if (shown.has(url)) return { decoding: 'sync', loading: 'eager' };
  return { decoding: 'async', loading: priority ? 'eager' : 'lazy' };
}

/** Ключ записи кэша как адрес в `<img src>`: свой origin — путь с запросом, чужой — адрес целиком. */
function srcKey(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return u.origin === origin ? u.pathname + u.search : u.href;
  } catch {
    return url;
  }
}

/**
 * После перезапуска `shown` пуст, хотя картинки лежат в кэше service worker: без этого первый кадр — пустая плашка
 * (`lazy`/`async`). Один раз читает ключи кэша изображений и помечает их показанными. Замер в Chromium: `cache.keys()`
 * на 1000 записях — 9 мс, на 5000 — ~45 мс (вне основного потока ввода-вывода); на десятках тысяч браузер отвечает
 * «Operation too large» — тогда остаётся прежнее поведение (ленивая загрузка). Берутся последние `MAX_SHOWN` ключей.
 */
export async function primeShownFromCache(
  open: () => Promise<Pick<Cache, 'keys'>> = () => caches.open(IMAGE_CACHE),
  origin: string = globalThis.location?.origin ?? '',
): Promise<number> {
  try {
    const keys = await (await open()).keys();
    const recent = keys.length > MAX_SHOWN ? keys.slice(keys.length - MAX_SHOWN) : keys;
    for (const r of recent) shown.add(srcKey(r.url, origin));
    return recent.length;
  } catch {
    return 0;
  }
}

/** Для тестов. */
export function resetShownImages(): void {
  shown.clear();
  broken.clear();
}
