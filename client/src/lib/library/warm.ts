import type { Album, Artist } from '@/lib/db/types';
import { artistImageUrl } from '@/lib/platform/urls';
import type { CacheLike } from '@/sw/cache';
import { coverSrc } from './cover';

// Фоновый прогрев миниатюр библиотеки в кэш изображений service worker (ревью S12): экран, который открывают впервые
// или без сети, рисуется с картинками, а не пустыми плашками. Логика чистая — браузерная обвязка в `warm-runtime.ts`.

/**
 * Сколько последних добавленных альбомов прогревается. Замер (реальные миниатюры на этой машине: обложка 250 px —
 * 19 КБ в среднем по 403 файлам, фото артиста — 56 КБ по 39): библиотека `just load` (300 артистов × 15 альбомов)
 * — около 4500 обложек ≈ 85 МБ и 300 фото ≈ 17 МБ, то есть ~4800 запросов и ~100 МБ. Заметно, поэтому по умолчанию —
 * все фото артистов с `image = 'yes'` и 500 последних альбомов (≈ 10 МБ на обложки).
 */
export const WARM_ALBUMS_LIMIT = 500;
/** Одновременных запросов прогрева. */
export const WARM_CONCURRENCY = 2;
/** Пауза после последней навигации: пока пользователь переходит по экранам, фон молчит. */
export const WARM_NAV_QUIET_MS = 2000;
/** Как часто проверяется, не закончилась ли пауза. */
const POLL_MS = 500;

/** Адреса миниатюр, которые стоит прогреть: фото артистов с `image = 'yes'`, затем обложки 250 px свежих альбомов. */
export function warmTargets(
  artists: Iterable<Artist>,
  albums: Iterable<Album>,
  albumLimit: number = WARM_ALBUMS_LIMIT,
): string[] {
  const urls: string[] = [];
  for (const a of artists) if (a.in_library && a.image === 'yes') urls.push(artistImageUrl(a.mbid));
  const covered = [...albums]
    .filter(a => a.in_library)
    .map(a => ({ a, src: coverSrc(a.cover_url, 250) }))
    .filter((x): x is { a: Album; src: string } => x.src !== null)
    .sort((x, y) => (y.a.added_at ?? '').localeCompare(x.a.added_at ?? '') || y.a.id - x.a.id)
    .slice(0, albumLimit);
  for (const { src } of covered) urls.push(src);
  return urls;
}

export type WarmDeps = {
  cache: CacheLike;
  /** Загрузка картинки; ответ не `ok` пропускается без записи. */
  fetch: (url: string) => Promise<Response>;
  /** Включён ли прогрев (настройка) — проверяется перед каждой загрузкой. */
  enabled: () => boolean;
  /** Режим экономии трафика: прогрев останавливается совсем. */
  saveData: () => boolean;
  /** Идёт воспроизведение со стрима или пользователь только что переходил по экранам: ждём. */
  paused: () => boolean;
  sleep: (ms: number) => Promise<void>;
  concurrency?: number;
  /** Сколько адресов уже в кэше (пропущены и загружены) — для индикатора в настройках. */
  onProgress?: (p: WarmProgress) => void;
  /** Остановка (смена списка, выход из аккаунта). */
  signal?: AbortSignal;
};

export type WarmProgress = {
  total: number;
  /** Уже в кэше: найдены при запуске или загружены. */
  warmed: number;
  /** Причина остановки или `done`. */
  state: 'running' | 'paused' | 'done' | 'stopped';
};

/**
 * Прогревает `urls`: то, что уже в кэше (`cache.match`), пропускается — прогрев продолжается после перезапуска.
 * Не более `concurrency` запросов за раз; на `saveData`, выключенной настройке или `signal` останавливается
 * (повторный запуск продолжит с места), на `paused()` — ждёт. Ошибка одной картинки не мешает остальным.
 */
export async function runWarm(urls: readonly string[], deps: WarmDeps): Promise<WarmProgress> {
  const { cache, signal } = deps;
  const total = urls.length;
  let warmed = 0;
  let stopped = false;
  let state: WarmProgress['state'] = 'running';
  const report = () => deps.onProgress?.({ state, total, warmed });
  const mustStop = () => stopped || signal?.aborted === true || deps.saveData() || !deps.enabled();
  report();

  let next = 0;
  async function worker() {
    for (;;) {
      if (mustStop()) {
        stopped = true;
        return;
      }
      if (deps.paused()) {
        if (state !== 'paused') {
          state = 'paused';
          report();
        }
        await deps.sleep(POLL_MS);
        continue;
      }
      if (state === 'paused') {
        state = 'running';
        report();
      }
      const i = next++;
      if (i >= total) return;
      const request = new Request(urls[i] as string);
      try {
        if (await cache.match(request, { ignoreVary: true })) {
          warmed++;
        } else {
          const response = await deps.fetch(urls[i] as string);
          if (response.ok) {
            await cache.put(request, response);
            warmed++;
          }
        }
      } catch {
        // Сеть или хранилище: эту картинку пропускаем, следующий запуск попробует снова.
      }
      report();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? WARM_CONCURRENCY) }, worker));
  state = stopped ? 'stopped' : 'done';
  report();
  return { state, total, warmed };
}
