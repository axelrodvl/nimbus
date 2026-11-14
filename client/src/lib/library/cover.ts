/** Размеры миниатюр Cover Art Archive: карточки — 250, шапка альбома — 500. */
export type CoverThumb = 250 | 500;

const CAA_FRONT = /^(https?:\/\/coverartarchive\.org\/.+\/front)(-\d+)?$/;

/**
 * Адрес обложки под размер места. Бэкенд отдаёт Cover Art Archive вида `…/front[-N]`: подставляем нужную
 * миниатюру, чтобы не тянуть оригинал в карточку. Любой другой адрес возвращается как есть.
 */
export function coverSrc(url: string | null | undefined, thumb: CoverThumb): string | null {
  if (!url) return null;
  const m = CAA_FRONT.exec(url);
  return m ? `${m[1]}-${thumb}` : url;
}
