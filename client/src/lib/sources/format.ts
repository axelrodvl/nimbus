import type { MessageKey, TFn } from '@/lib/i18n/messages';

const UNITS = ['unit.B', 'unit.KB', 'unit.MB', 'unit.GB', 'unit.TB'] as const satisfies readonly MessageKey[];

/** Размер в байтах: «12 MB», «1.4 GB»; нет значения — «—». */
export function formatSize(bytes: number | null | undefined, t: TFn): string {
  if (bytes == null) return '—';
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${t(UNITS[i])}`;
}

const SOURCE_NAMES: Record<string, string> = { rutracker: 'RuTracker', torznab: 'Torznab', tpb: 'TPB' };

export function sourceLabel(source: string, t: TFn): string {
  return source === 'manual' ? t('source.manual') : (SOURCE_NAMES[source] ?? source);
}

export function kindLabel(kind: string, t: TFn): string {
  switch (kind) {
    case 'album':
      return t('kind.album');
    case 'discography':
      return t('kind.discography');
    case 'single':
      return t('kind.single');
    default:
      return '—';
  }
}

const META_KEYS: Record<string, MessageKey> = {
  dead: 'meta.dead',
  error: 'meta.error',
  fetching: 'meta.fetching',
  ok: 'meta.ok',
  pending: 'meta.pending',
  timeout: 'meta.timeout',
};

/** Статус получения метаданных раздачи; неизвестный статус показывается как есть. */
export function metaLabel(status: string, t: TFn): string {
  const key = META_KEYS[status];
  return key ? t(key) : status;
}
