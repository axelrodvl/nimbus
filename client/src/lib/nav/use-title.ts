import { useEffect } from 'react';

const BASE = 'Nimbus';

/** Заголовок вкладки: `«<title> · Nimbus»`; при уходе с экрана возвращается `Nimbus`. */
export function useTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE;
    return () => {
      document.title = BASE;
    };
  }, [title]);
}
