import { coverUrl } from '@/lib/platform/urls';

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
