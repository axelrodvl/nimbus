import type { AcquisitionItem, AcquisitionPage, AcquisitionSummary, EngineTorrent } from '@/lib/api/acquisition';
import type { MessageKey } from '@/lib/i18n/messages';
import ru from '@/lib/i18n/messages/ru';
import { translate, type Params } from '@/lib/i18n/translate';

/** Перевод на русский для проверок текста: `L('acq.found', { found: 1, total: 2 })`. */
export const L = (key: MessageKey, params?: Params) => translate(ru, 'ru', key, params);

export const summary = (over: Partial<AcquisitionSummary> = {}): AcquisitionSummary => ({
  available: 0,
  downloaded: 0,
  downloading: 0,
  failed_jobs: 0,
  missing: 0,
  partial: 0,
  searching: 0,
  ...over,
});

/** Строка списка приобретения; `id` определяет и альбом, и артиста. */
export function item(id: number, over: Partial<AcquisitionItem> = {}): AcquisitionItem {
  return {
    active_jobs: 0,
    album: { artist: { id: 100 + id, name: `Artist ${id}` }, cover_url: null, id, title: `Album ${id}`, year: 2000 },
    download: null,
    reason: null,
    search: {
      attempts: 0,
      candidates: 0,
      last_finished_at: null,
      last_outcome: null,
      next_retry_at: null,
      provider_errors: [],
    },
    state: 'missing',
    tracks: { adding: 0, found: 0, not_found: 3, ready: 0, total: 3 },
    ...over,
  };
}

export const page = (items: AcquisitionItem[], next: string | null = null): AcquisitionPage => ({
  items,
  next_cursor: next,
});

export const torrent = (hash: string, over: Partial<EngineTorrent> = {}): EngineTorrent => ({
  down_bps: 0,
  finished: false,
  info_hash: hash,
  name: `Torrent ${hash}`,
  peers: 0,
  progress_bytes: 0,
  seeds: 0,
  state: 'downloading',
  total_bytes: 100,
  up_bps: 0,
  uploaded_bytes: 0,
  ...over,
});
