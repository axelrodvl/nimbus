/** Файлы `dist`, на которые ссылается index.html: скрипты, modulepreload, стили (то, что грузится до первого экрана). */
export function initialAssets(html: string): { css: string[]; js: string[] } {
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1];
  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map(m => m[0]);
  const css: string[] = [];
  const js: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith('<script') && /type="module"/.test(tag)) {
      const src = attr(tag, 'src');
      if (src) js.push(src);
    } else if (/rel="modulepreload"/.test(tag)) {
      const href = attr(tag, 'href');
      if (href) js.push(href);
    } else if (/rel="stylesheet"/.test(tag)) {
      const href = attr(tag, 'href');
      if (href) css.push(href);
    }
  }
  return { css, js };
}
