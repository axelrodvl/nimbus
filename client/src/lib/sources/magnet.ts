export type MagnetCheck = 'ok' | 'empty' | 'format';

/**
 * Проверка magnet-ссылки на клиенте (сервер проверяет строже): схема `magnet:`, параметр `xt=urn:btih:` с хешем
 * из 40 hex-символов или 32 символов base32. Пустая строка — отдельный случай (кнопка просто выключена).
 */
export function checkMagnet(input: string): MagnetCheck {
  const value = input.trim();
  if (!value) return 'empty';
  if (!/^magnet:\?/i.test(value)) return 'format';
  const params = new URLSearchParams(value.slice(value.indexOf('?') + 1));
  const hash = params
    .getAll('xt')
    .map(xt => /^urn:btih:(.+)$/i.exec(xt)?.[1])
    .find(h => h !== undefined);
  if (!hash) return 'format';
  return /^[0-9a-f]{40}$/i.test(hash) || /^[a-z2-7]{32}$/i.test(hash) ? 'ok' : 'format';
}
