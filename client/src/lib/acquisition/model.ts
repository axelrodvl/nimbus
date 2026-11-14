import type { MessageKey, TFn } from '@/lib/i18n/messages';
import type { AcquisitionItem, AcquisitionState, AcquisitionSummary } from '@/lib/api/acquisition';

/** Вкладки экрана «Загрузки» в порядке показа. */
export const DOWNLOAD_TABS = [
  'attention',
  'searching',
  'downloading',
  'available',
  'downloaded',
  'torrents',
  'jobs',
  'device',
] as const;
export type DownloadTab = (typeof DOWNLOAD_TABS)[number];

/** Вкладки, содержимое которых — список альбомов с сервера. */
export type AlbumTab = 'attention' | 'searching' | 'downloading' | 'available' | 'downloaded';

export const isDownloadTab = (value: string | undefined): value is DownloadTab =>
  DOWNLOAD_TABS.includes(value as DownloadTab);
export const isAlbumTab = (tab: DownloadTab): tab is AlbumTab =>
  tab !== 'torrents' && tab !== 'jobs' && tab !== 'device';

/**
 * Вкладки в порядке показа. «На устройстве» есть, только если поддерживается офлайн-хранилище: в конце списка,
 * а без связи — первой (серверные вкладки без сервера недоступны).
 */
export function downloadTabs(deviceSupported: boolean, offline: boolean): readonly DownloadTab[] {
  const server = DOWNLOAD_TABS.filter(tab => tab !== 'device');
  if (!deviceSupported) return server;
  return offline ? ['device', ...server] : [...server, 'device'];
}

/** Какие состояния сервера запрашивает вкладка. «Загружаются» и «Доступны» дополнительно фильтруются на клиенте. */
export const TAB_STATES: Record<AlbumTab, readonly AcquisitionState[]> = {
  attention: ['missing', 'partial'],
  available: ['available'],
  downloaded: ['downloaded'],
  downloading: ['downloading', 'available'],
  searching: ['searching'],
};

/** Число альбомов, требующих внимания (значок в навигации и счётчик вкладки). */
export const attentionCount = (s: AcquisitionSummary | undefined): number => (s ? s.missing + s.partial : 0);

/** Счётчик вкладки по сводке; у «Торренты» его нет, у «Задачи» — число упавших задач. */
export function tabCount(tab: DownloadTab, s: AcquisitionSummary | undefined): number | undefined {
  if (!s) return undefined;
  switch (tab) {
    case 'attention':
      return attentionCount(s);
    case 'searching':
      return s.searching;
    case 'downloading':
      return s.downloading;
    case 'available':
      return s.available;
    case 'downloaded':
      return s.downloaded;
    case 'jobs':
      return s.failed_jobs;
    default:
      return undefined;
  }
}

/** Вкладка по умолчанию: «Требуют внимания», если не пуста, иначе первая непустая, иначе «Скачаны». */
export function defaultTab(s: AcquisitionSummary | undefined): DownloadTab {
  if (!s) return 'attention';
  const order: AlbumTab[] = ['attention', 'downloading', 'searching', 'available', 'downloaded'];
  return order.find(tab => (tabCount(tab, s) ?? 0) > 0) ?? 'attention';
}

/** Альбом сейчас загружается на сервер или ждёт своей очереди (закреплён и не завершён). */
export function isActiveDownload(item: AcquisitionItem): boolean {
  if (item.state === 'downloading') return true;
  const d = item.download;
  return !!d?.pinned && !!d.state && d.state !== 'done';
}

/** Фильтр строк вкладки поверх ответа сервера. */
export function tabFilter(tab: AlbumTab): (item: AcquisitionItem) => boolean {
  if (tab === 'downloading') return isActiveDownload;
  if (tab === 'available') return item => !isActiveDownload(item);
  return () => true;
}

const REASONS: Record<string, [MessageKey, MessageKey]> = {
  dead_torrents: ['status.reason.dead_torrents', 'acq.hint.dead_torrents'],
  no_match: ['status.reason.no_match', 'acq.hint.no_match'],
  no_torrents: ['status.reason.no_torrents', 'acq.hint.no_torrents'],
  search_failed: ['status.reason.search_failed', 'acq.hint.search_failed'],
};

/** Причина «не найдено» человеческим текстом и подсказка, что делать; неизвестный код — без текста. */
export function reasonText(reason: string | null | undefined, t: TFn): { reason: string; hint: string } | null {
  const keys = reason ? REASONS[reason] : undefined;
  return keys ? { hint: t(keys[1]), reason: t(keys[0]) } : null;
}

/** Исход последнего поиска для строки «В поиске»/«Доступны». */
export function outcomeText(outcome: string | null | undefined, t: TFn): string | null {
  return outcome ? (reasonText(outcome, t)?.reason ?? null) : null;
}

/** «Следующий автоповтор через 5 мин» / «…скоро»; нет времени — `null`. */
export function nextRetryText(iso: string | null | undefined, now: number, t: TFn): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 60_000) return t('acq.nextRetrySoon');
  const minutes = Math.round(ms / 60_000);
  const time =
    minutes < 90 ? t('acq.minutes', { count: minutes }) : t('acq.hours', { count: Math.round(minutes / 60) });
  return t('acq.nextRetry', { time });
}

const PIN_KEYS: Record<string, MessageKey> = {
  done: 'acq.pin.done',
  downloading: 'acq.pin.downloading',
  failed: 'acq.pin.failed',
  queued: 'acq.pin.queued',
  waiting_source: 'acq.pin.waiting_source',
};

export const pinStateText = (state: string | null | undefined, t: TFn): string | null =>
  state && PIN_KEYS[state] ? t(PIN_KEYS[state]) : null;

/** Процент выполнения 0…100 (0, если размер неизвестен). */
export const percent = (done: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;

/** Размер, при котором массовый повтор требует подтверждения. */
export const BULK_CONFIRM_THRESHOLD = 50;

const JOB_KINDS: Record<string, MessageKey> = {
  discover_album: 'acq.job.discover_album',
  import_artist: 'acq.job.import_artist',
  process_cue: 'acq.job.process_cue',
  verify_torrent: 'acq.job.verify_torrent',
};

/** Ключ перевода вида задачи; неизвестный вид — `null` (показывается как есть). */
export const jobKindKey = (kind: string): MessageKey | null => JOB_KINDS[kind] ?? null;

/** К чему относится задача: альбом или артист из `payload` (если есть) — ссылка и подпись. */
export function jobTarget(payload: unknown): { to: string; label: MessageKey; id: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.album_id === 'number') return { id: p.album_id, label: 'acq.job.album', to: `/album/${p.album_id}` };
  if (typeof p.artist_id === 'number')
    return { id: p.artist_id, label: 'acq.job.artist', to: `/artist/${p.artist_id}` };
  return null;
}
