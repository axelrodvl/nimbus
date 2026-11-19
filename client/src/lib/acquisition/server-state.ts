import type { AcquisitionState, PinState } from '@/lib/api/acquisition';
import type { Track } from '@/lib/db/types';

/**
 * Состояние альбома на сервере, вычисленное из синхронизированных треков (ревью S11) — без запроса к
 * `/api/acquisition`. Повторяет `state_cte!` бэкенда (`crates/db/src/repo/acquisition.rs`); совпадение проверяет
 * общий файл примеров `backend/crates/db/tests/fixtures/album-server-state.json`.
 */
export type AlbumServerState = {
  state: AcquisitionState;
  /** У треков альбома из библиотеки есть закрепления. */
  pinned: boolean;
  /** Агрегат закреплений: `downloading > queued > failed > waiting_source > done`; `null` — ничего не закреплено. */
  pin: PinState | null;
  /** Причина `failed`: первая по кодам символов, как `min(error COLLATE "C")` на сервере. */
  pinError: string | null;
};

const PIN_ORDER: readonly PinState[] = ['downloading', 'queued', 'failed', 'waiting_source', 'done'];

/**
 * `tracks` — треки альбома (каталожные, `in_library = false`, не считаются). `null` — у альбома нет треков в библиотеке
 * (сервер его не знает).
 *
 * «Качается» — есть закрепление в состоянии `downloading` (менеджер загрузок ставит его вместе с загрузкой файла).
 * Live-прогресс (`download.progress`) на состояние не влияет — только на байты: запись в LiveStore может пережить
 * отмену закрепления. Отличие от сервера: загрузку без закрепления (файл докачивается ради потока) клиент не видит —
 * у такого альбома `available`, и кнопка предлагает скачать его целиком; сервер говорит `downloading`.
 */
export function albumServerState(tracks: Iterable<Track | undefined>): AlbumServerState | null {
  let total = 0;
  let adding = 0;
  let found = 0;
  let notFound = 0;
  let ready = 0;
  let pinIdx: number = PIN_ORDER.length;
  let pinError: string | null = null;
  let pinDownloading = false;
  for (const t of tracks) {
    if (!t?.in_library) continue;
    total += 1;
    if (t.status === 'adding') adding += 1;
    else if (t.status === 'found') found += 1;
    else if (t.status === 'not_found') notFound += 1;
    else ready += 1;
    const pin = t.pin ?? null;
    if (!pin) continue;
    pinIdx = Math.min(pinIdx, PIN_ORDER.indexOf(pin));
    if (pin === 'downloading') pinDownloading = true;
    if (pin === 'failed' && t.pin_error && (pinError === null || t.pin_error < pinError)) pinError = t.pin_error;
  }
  if (total === 0) return null;
  const pin = PIN_ORDER[pinIdx] ?? null;
  let state: AcquisitionState;
  if (adding > 0) state = 'searching';
  else if (pinDownloading) state = 'downloading';
  else if (notFound > 0 && found + ready > 0) state = 'partial';
  else if (notFound > 0) state = 'missing';
  else if (ready === total) state = 'downloaded';
  else state = 'available';
  return { pin, pinError, pinned: pin !== null, state };
}

/** Альбом загружается на сервер или ждёт своей очереди (как `isActiveDownload` для строки списка). */
export const isActiveServerDownload = (s: AlbumServerState): boolean =>
  s.state === 'downloading' || (s.pinned && s.pin !== null && s.pin !== 'done');
