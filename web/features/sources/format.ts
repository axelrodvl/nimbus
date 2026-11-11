import type { TFn } from '@/providers/i18n-provider';

export function formatSize(bytes: number | null | undefined, t: TFn): string {
  if (bytes == null) return '—';
  const units = ['unit.B', 'unit.KB', 'unit.MB', 'unit.GB', 'unit.TB'] as const;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${t(units[i])}`;
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

export function metaLabel(status: string, t: TFn): string {
  switch (status) {
    case 'dead':
      return t('meta.dead');
    case 'error':
      return t('meta.error');
    case 'fetching':
      return t('meta.fetching');
    case 'ok':
      return t('meta.ok');
    case 'pending':
      return t('meta.pending');
    case 'timeout':
      return t('meta.timeout');
    default:
      return status;
  }
}
