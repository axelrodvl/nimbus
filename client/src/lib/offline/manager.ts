import type { Db, OfflineFile, OfflinePin } from '@/lib/db';
import type { LibraryStore } from '@/lib/store/library';
import type { Tabs } from '@/lib/sync/tabs';
import { effectiveLimit, type OfflineSettingsStore } from './settings';
import {
  albumTrackIds,
  FAVORITES_PIN_ID,
  fromSnapshot,
  initialOfflineStatus,
  playlistTrackIds,
  toSnapshot,
  type OfflineBlock,
  type OfflineFileStatus,
  type OfflineSnapshot,
  type OfflineStatus,
  type OfflineStatusStore,
} from './status';
import type { Downloader, DownloadMessage, OfflineStorage } from './types';

export const MAX_ATTEMPTS = 8;
/** Паузы перед повтором: 5 с → 30 с → 2 мин → 10 мин → 1 ч (дальше — раз в час). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
export const RECONCILE_DEBOUNCE_MS = 1000;
/** Оценка размера, пока он неизвестен (перекодируемый поток без `Content-Length`). */
export const ESTIMATED_TRACK_BYTES = 15 * 2 ** 20;
/** Как часто прогресс скачивания пишется в IndexedDB (iOS может выгрузить вкладку в любой момент). */
export const PERSIST_PROGRESS_MS = 2000;
export const STATUS_BROADCAST_MS = 500;
/** Не чаще раза в это время прогресс скачивания попадает в store (один общий таймер на все загрузки). */
export const PROGRESS_PUBLISH_MS = 250;

export type PinKind = OfflinePin['kind'];

/** Сообщения между вкладками (`BroadcastChannel('nimbus-offline')`): лидер публикует состояние, остальные шлют команды. */
export type OfflineTabMessage =
  | { type: 'status'; snapshot: OfflineSnapshot }
  | { type: 'pins' }
  | { type: 'broken'; trackId: number }
  | { type: 'retry'; trackId: number }
  | { type: 'paused'; value: boolean }
  | { type: 'removeAll' };

export type OfflineDb = Pick<
  Db,
  'offlineLoad' | 'offlinePinPut' | 'offlinePinDelete' | 'offlineFilePut' | 'offlineFileDelete' | 'offlineClear'
>;

export type ManagerDeps = {
  db: OfflineDb;
  storage: OfflineStorage;
  downloader: Downloader;
  library: LibraryStore;
  status: OfflineStatusStore;
  settings: OfflineSettingsStore;
  tabs: Tabs<OfflineTabMessage>;
  network: {
    /** Сеть браузера есть и сервер доступен (та же логика, что `useOnline`). */
    online(): boolean;
    subscribe(listener: () => void): () => void;
    /** Сотовая сеть (`navigator.connection.type`); где API нет — `false`. */
    cellular(): boolean;
  };
  /** Адрес полного файла трека (`/stream?download=1`). */
  downloadUrl(trackId: number): string;
  headers(): Record<string, string>;
  /** 401 от сервера: общий обработчик потери входа. */
  onUnauthorized?(): void;
  /** Неожиданный сбой фоновой операции (IndexedDB закрыта, хранилище отказало): менеджер продолжает, повтор — со следующим событием. */
  onError?(error: unknown): void;
  /** Система очистила скачанное: у `count` записей «готово» файла на диске уже нет (они вернутся в очередь). */
  onStorageCleared?(count: number): void;
  /** Id треков «Избранного» (динамический плейлист) по текущей библиотеке; без функции «Избранное» не закрепляется. */
  favoriteIds?(): number[];
  /** Можно ли удалять закрепления и файлы по данным библиотеки (нет, пока идёт снимок: библиотека неполна). */
  libraryComplete?(): boolean;
  now?(): number;
};

const key = (kind: PinKind, id: number) => `${kind}:${id}`;
const playable = (status: string | undefined) => status === 'found' || status === 'ready';

/**
 * Менеджер офлайн-треков: закрепления → нужные файлы (сверка с библиотекой), очередь скачивания с повторами,
 * лимит места, целостность при старте. Скачивает одна вкладка (лидер, Web Lock `nimbus-offline`); остальные
 * показывают её состояние и присылают команды. Платформа — только за `OfflineStorage` и `Downloader`.
 */
export function createOfflineManager(deps: ManagerDeps) {
  const { db, storage, downloader, library, status, settings, tabs } = deps;
  const now = deps.now ?? Date.now;

  let pins = new Map<string, OfflinePin>();
  const files = new Map<number, OfflineFile>();
  /** Нужные треки в порядке очереди: позже закреплён → позже; внутри закрепления — порядок воспроизведения. */
  let order = new Map<number, number>();
  const inflight = new Set<number>();
  const lastPersist = new Map<number, number>();
  let leader = false;
  let stopped = false;
  let paused = false;
  let unauthorized = false;
  /** Очередь упёрлась в лимит места (пересчитывается при каждом `pump`). */
  let quotaHit = false;
  /** Воркер сообщил `QuotaExceededError`: стоим, пока пользователь не освободит место или не поднимет лимит. */
  let quotaError = false;
  let usage = { bytes: 0, quota: null as number | null };
  let wake: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Окно троттлинга прогресса: пока таймер жив, новые `progress` только помечают `progressDirty`. */
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let progressDirty = false;
  /** Последние опубликованные статусы файлов: запись заменяется новым объектом, только если изменилось поле. */
  let published = new Map<number, OfflineFileStatus>();
  let doneRevision = 0;
  /** Закрепления менялись с прошлой публикации: `pins`/`pinTimes` нужно пересоздать. */
  let pinsDirty = true;
  let pinsSet = new Set<string>();
  let pinTimesObj: Record<string, number> = {};
  let lastVersion = -1;
  let leading: Promise<void> | null = null;
  const unsubscribers: (() => void)[] = [];
  const queued = new Set<Promise<unknown>>();
  /** Отмены, ещё не подтверждённые загрузчиком: пока файл занят, его нельзя удалять. */
  const aborting = new Set<Promise<void>>();

  /** Фоновая операция, которую можно дождаться в тестах (`settled()`); сбой сообщается через `onError`, а не теряется. */
  const track = <T>(p: Promise<T>): Promise<T> => {
    queued.add(p);
    p.then(
      () => queued.delete(p),
      e => {
        queued.delete(p);
        deps.onError?.(e);
      },
    );
    return p;
  };

  /** Прерывает загрузку трека; промис завершается, когда загрузчик освободил файл. */
  function abortDownload(trackId: number): Promise<void> {
    const p = Promise.resolve(downloader.abort(String(trackId))).then(
      () => undefined,
      () => undefined,
    );
    aborting.add(p);
    void p.then(() => aborting.delete(p));
    return p;
  }

  const filesReleased = () => Promise.all([...aborting]).then(() => undefined);

  const persist = (f: OfflineFile) => {
    lastPersist.set(f.track_id, now());
    return db.offlineFilePut({ ...f }).catch(() => undefined);
  };

  // ------------------------------------------------------------------ состояние для интерфейса

  function block(): OfflineBlock {
    if (unauthorized) return 'unauthorized';
    if (paused) return 'paused';
    if (!deps.network.online()) return 'offline';
    if (settings.getState().wifiOnly && deps.network.cellular()) return 'wifi';
    if (quotaHit || quotaError) return 'quota';
    return 'none';
  }

  /** Закрепления в публикуемом виде: пересоздаются только после изменения (иначе ссылки остаются прежними). */
  function refreshPins(): Partial<OfflineStatus> {
    if (!pinsDirty) return {};
    pinsDirty = false;
    pinsSet = new Set(pins.keys());
    pinTimesObj = Object.fromEntries([...pins].map(([k, p]) => [k, p.created_at]));
    return { pinTimes: pinTimesObj, pins: pinsSet };
  }

  /**
   * Лидер публикует всё состояние; остальные вкладки — только закрепления (файлы им присылает лидер).
   * В store попадает только изменившееся: статус файла без изменений остаётся тем же объектом, а если не изменилось
   * ничего — `setState` не вызывается.
   */
  function publish(full = leader) {
    if (!full) {
      const patch = refreshPins();
      if (Object.keys(patch).length > 0) status.setState(patch);
      return;
    }
    progressDirty = false;
    const cur = status.getState();
    const patch: Partial<OfflineStatus> = refreshPins();
    const next = new Map<number, OfflineFileStatus>();
    let filesChanged = published.size !== files.size;
    let doneChanged = false;
    let queueLength = 0;
    for (const f of files.values()) {
      const prev = published.get(f.track_id);
      const entry = prev && sameStatus(prev, f) ? prev : statusOf(f);
      if (entry !== prev) filesChanged = true;
      if ((prev?.state === 'done') !== (f.state === 'done')) doneChanged = true;
      next.set(f.track_id, entry);
      if (f.state === 'queued') queueLength++;
    }
    if (published.size !== files.size) {
      for (const [id, prev] of published) if (prev.state === 'done' && !files.has(id)) doneChanged = true;
    }
    if (filesChanged) {
      published = next;
      patch.files = next;
    }
    if (doneChanged) patch.doneRevision = ++doneRevision;
    const usageNow = { ...usage, limit: effectiveLimit(settings.getState(), usage.quota) };
    if (
      cur.usage.bytes !== usageNow.bytes ||
      cur.usage.quota !== usageNow.quota ||
      cur.usage.limit !== usageNow.limit
    ) {
      patch.usage = usageNow;
    }
    const blocked = block();
    if (cur.activeCount !== inflight.size) patch.activeCount = inflight.size;
    if (cur.blocked !== blocked) patch.blocked = blocked;
    if (cur.paused !== paused) patch.paused = paused;
    if (cur.queueLength !== queueLength) patch.queueLength = queueLength;
    if (Object.keys(patch).length === 0) return;
    status.setState(patch);
    if (leader && !stopped) scheduleBroadcast();
  }

  const sameStatus = (a: OfflineFileStatus, f: OfflineFile) =>
    a.state === f.state &&
    a.bytesDone === f.bytes_done &&
    a.bytesTotal === f.bytes_total &&
    a.mime === f.mime &&
    a.error === f.error;

  const statusOf = (f: OfflineFile): OfflineFileStatus => ({
    bytesDone: f.bytes_done,
    bytesTotal: f.bytes_total,
    error: f.error,
    mime: f.mime,
    state: f.state,
  });

  /** Прогресс скачивания: первое сообщение публикуется сразу, дальнейшие — не чаще `PROGRESS_PUBLISH_MS` (с хвостовым вызовом). */
  function publishProgress() {
    if (progressTimer !== undefined) {
      progressDirty = true;
      return;
    }
    publish();
    startProgressWindow();
  }

  function startProgressWindow() {
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      if (stopped || !progressDirty) return;
      publish(); // сбрасывает `progressDirty`
      startProgressWindow();
    }, PROGRESS_PUBLISH_MS);
  }

  function scheduleBroadcast() {
    if (broadcastTimer !== undefined) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      if (stopped) return;
      tabs.post({ snapshot: toSnapshot(status.getState()), type: 'status' });
    }, STATUS_BROADCAST_MS);
  }

  async function refreshUsage() {
    try {
      usage = await storage.usage();
    } catch {
      // Оценка недоступна: считаем по прежнему значению.
    }
    publish();
  }

  // ------------------------------------------------------------------ закрепления

  async function reloadFromDb() {
    const loaded = await db.offlineLoad();
    pins = new Map(loaded.pins.map(p => [p.key, p]));
    pinsDirty = true;
    return loaded;
  }

  async function pin(kind: PinKind, id: number) {
    const k = key(kind, id);
    if (pins.has(k)) return;
    const p: OfflinePin = { created_at: now(), id, key: k, kind };
    pins.set(k, p);
    pinsDirty = true;
    publish();
    await db.offlinePinPut(p);
    afterPinChange();
  }

  async function unpin(kind: PinKind, id: number) {
    const k = key(kind, id);
    if (!pins.delete(k)) return;
    pinsDirty = true;
    publish();
    await db.offlinePinDelete(k);
    afterPinChange();
  }

  function afterPinChange() {
    if (leader) track(reconcile());
    else tabs.post({ type: 'pins' });
  }

  // ------------------------------------------------------------------ сверка

  /** Приводит файлы к набору, нужному закреплениям; закрепления на удалённые сущности снимает. */
  let reconcileRun: Promise<void> = Promise.resolve();
  const reconcile = (): Promise<void> => (reconcileRun = reconcileRun.then(doReconcile, doReconcile));

  async function doReconcile() {
    if (!leader || stopped) return;
    const lib = library.getState();
    if (!lib.hydrated) return;
    const prune = deps.libraryComplete?.() ?? true;
    const needed = new Map<number, number>();
    const add = (id: number) => {
      if (!needed.has(id)) needed.set(id, needed.size);
    };
    const stale: OfflinePin[] = [];
    for (const p of [...pins.values()].sort((a, b) => a.created_at - b.created_at || a.key.localeCompare(b.key))) {
      if (p.kind === 'track') {
        if (lib.tracks.has(p.id)) add(p.id);
        else stale.push(p);
      } else if (p.kind === 'album') {
        if (lib.albums.has(p.id)) albumTrackIds(lib, p.id).forEach(add);
        else stale.push(p);
      } else if (p.id === FAVORITES_PIN_ID) deps.favoriteIds?.().forEach(add);
      else if (lib.playlists.has(p.id)) playlistTrackIds(lib, p.id).forEach(add);
      else stale.push(p);
    }
    // Библиотека неполна (идёт снимок) — ничего не удаляем.
    if (!prune) {
      for (const id of files.keys()) if (!needed.has(id)) add(id);
    } else {
      for (const p of stale) {
        pins.delete(p.key);
        pinsDirty = true;
        await db.offlinePinDelete(p.key).catch(() => undefined);
      }
    }
    order = needed;
    const unneeded = [...files.keys()].filter(id => !needed.has(id));
    for (const id of unneeded) await removeFile(id);
    // Место освободилось: очередь, стоявшая из-за лимита, должна это увидеть.
    if (unneeded.length > 0) await refreshUsage();
    for (const id of needed.keys()) {
      if (files.has(id)) continue;
      const f = newRecord(id);
      files.set(id, f);
      await persist(f);
    }
    publish();
    pump();
  }

  const newRecord = (trackId: number): OfflineFile => ({
    attempts: 0,
    bytes_done: 0,
    bytes_total: null,
    completed_at: null,
    error: null,
    etag: null,
    mime: 'application/octet-stream',
    next_attempt_at: null,
    resumable: false,
    state: 'queued',
    track_id: trackId,
  });

  async function removeFile(trackId: number) {
    if (inflight.delete(trackId)) abortDownload(trackId);
    files.delete(trackId);
    lastPersist.delete(trackId);
    await filesReleased();
    await storage.remove(String(trackId)).catch(() => undefined);
    await db.offlineFileDelete(trackId).catch(() => undefined);
    quotaError = false;
  }

  // ------------------------------------------------------------------ очередь

  function pump() {
    if (!leader || stopped) return;
    quotaHit = false;
    clearTimeout(wake);
    wake = undefined;
    if (block() === 'none') {
      const lib = library.getState();
      const limit = effectiveLimit(settings.getState(), usage.quota);
      const concurrency = settings.getState().concurrency;
      const candidates = [...files.values()]
        .filter(f => f.state === 'queued' && !inflight.has(f.track_id))
        .sort((a, c) => (order.get(a.track_id) ?? 0) - (order.get(c.track_id) ?? 0));
      let nextWake: number | null = null;
      for (const f of candidates) {
        if (inflight.size >= concurrency) break;
        if (f.next_attempt_at !== null && f.next_attempt_at > now()) {
          nextWake = Math.min(nextWake ?? Infinity, f.next_attempt_at);
          continue;
        }
        // Трек ещё не готов (`adding`, `not_found`): запись ждёт, пока статус изменится.
        if (!playable(lib.tracks.get(f.track_id)?.status)) continue;
        if (usage.bytes + remainingBytes() + (f.bytes_total ?? ESTIMATED_TRACK_BYTES) - f.bytes_done > limit) {
          quotaHit = true;
          break;
        }
        begin(f);
      }
      if (nextWake !== null) wake = setTimeout(pump, Math.max(0, nextWake - now()));
    }
    publish();
  }

  const remainingBytes = () => {
    let sum = 0;
    for (const id of inflight) {
      const f = files.get(id);
      if (f) sum += Math.max(0, (f.bytes_total ?? ESTIMATED_TRACK_BYTES) - f.bytes_done);
    }
    return sum;
  };

  function begin(f: OfflineFile) {
    f.state = 'downloading';
    f.next_attempt_at = null;
    if (!f.resumable) f.bytes_done = 0;
    inflight.add(f.track_id);
    track(persist(f));
    downloader.start({
      etag: f.resumable ? f.etag : null,
      headers: deps.headers(),
      offset: f.resumable ? f.bytes_done : 0,
      trackId: String(f.track_id),
      url: deps.downloadUrl(f.track_id),
    });
  }

  async function onMessage(m: DownloadMessage) {
    if (m.type === 'aborted') return; // подтверждение отмены обрабатывает загрузчик
    const id = Number(m.trackId);
    const f = files.get(id);
    if (!f || !inflight.has(id) || stopped) return;
    if (m.type === 'progress') {
      f.bytes_done = m.bytesDone;
      f.bytes_total = m.bytesTotal;
      f.mime = m.mime || f.mime;
      f.etag = m.etag;
      f.resumable = m.resumable;
      if (now() - (lastPersist.get(id) ?? 0) >= PERSIST_PROGRESS_MS) track(persist(f));
      publishProgress();
      return;
    }
    inflight.delete(id);
    if (m.type === 'done') {
      Object.assign(f, {
        attempts: 0,
        bytes_done: m.bytes,
        bytes_total: m.bytes,
        completed_at: now(),
        error: null,
        etag: m.etag,
        mime: m.mime || f.mime,
        next_attempt_at: null,
        resumable: m.resumable,
        state: 'done',
      } satisfies Partial<OfflineFile>);
      await persist(f);
      await refreshUsage();
      pump();
      return;
    }
    failed(f, m);
    await persist(f);
    pump();
  }

  function failed(f: OfflineFile, m: Extract<DownloadMessage, { type: 'error' }>) {
    f.error = m.code;
    if (m.info) {
      f.etag = m.info.etag;
      f.mime = m.info.mime || f.mime;
      f.resumable = m.info.resumable;
      f.bytes_total = m.info.bytesTotal;
    }
    f.bytes_done = f.resumable ? m.bytesDone : 0;
    if (m.code === 'unauthorized') {
      f.state = 'queued';
      unauthorized = true;
      deps.onUnauthorized?.();
    } else if (m.code === 'quota') {
      f.state = 'queued';
      quotaError = true;
    } else if (!m.retryable) {
      f.state = 'failed';
    } else {
      f.attempts += 1;
      if (f.attempts >= MAX_ATTEMPTS) f.state = 'failed';
      else {
        f.state = 'queued';
        f.next_attempt_at = now() + RETRY_DELAYS_MS[Math.min(f.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      }
    }
  }

  // ------------------------------------------------------------------ целостность при старте

  /** Приводит записи к тому, что реально лежит на диске (вкладку могли выгрузить посреди загрузки). */
  async function checkIntegrity() {
    const names = new Set(await storage.list());
    let vanished = 0;
    for (const f of files.values()) {
      const size = await storage.size(String(f.track_id));
      names.delete(String(f.track_id));
      const before = f.state;
      if (f.state === 'done') {
        if (size === null) vanished++;
        if (size === null || size !== f.bytes_done) {
          Object.assign(f, { bytes_done: 0, completed_at: null, state: 'queued' } satisfies Partial<OfflineFile>);
        }
      } else if (f.state === 'downloading') {
        if (downloader.background) {
          if (size !== null && f.bytes_total !== null && size === f.bytes_total) {
            Object.assign(f, { bytes_done: size, completed_at: now(), state: 'done' } satisfies Partial<OfflineFile>);
          } else inflight.add(f.track_id); // ОС продолжает загрузку: ждём её сообщений.
        } else {
          f.state = 'queued';
          if (!f.resumable || size === null || size < f.bytes_done) f.bytes_done = 0;
        }
      }
      if (f.state !== before) await persist(f);
    }
    // Файл без записи — остаток прерванного удаления.
    for (const name of names) await storage.remove(name).catch(() => undefined);
    if (vanished > 0) deps.onStorageCleared?.(vanished);
  }

  // ------------------------------------------------------------------ вкладки

  function onTabMessage(m: OfflineTabMessage) {
    if (m.type === 'status') {
      if (!leader) status.setState(fromSnapshot(m.snapshot, status.getState().doneRevision));
      return;
    }
    if (!leader) return;
    switch (m.type) {
      case 'pins':
        track(reloadFromDb().then(reconcile));
        break;
      case 'broken':
        track(markBroken(m.trackId));
        break;
      case 'retry':
        retry(m.trackId);
        break;
      case 'paused':
        setPaused(m.value);
        break;
      case 'removeAll':
        track(removeAll());
        break;
    }
  }

  async function becomeLeader() {
    if (stopped) return;
    leader = true;
    await reloadFromDb().then(loaded => {
      files.clear();
      for (const f of loaded.files) files.set(f.track_id, f);
    });
    await checkIntegrity();
    await refreshUsage();
    unsubscribers.push(
      library.subscribe(state => {
        if (state.version === lastVersion) return;
        lastVersion = state.version;
        clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(() => track(reconcile()), RECONCILE_DEBOUNCE_MS);
      }),
      deps.network.subscribe(() => pump()),
      settings.subscribe(() => {
        quotaError = false;
        track(refreshUsage().then(pump));
      }),
    );
    lastVersion = library.getState().version;
    await reconcile();
  }

  // ------------------------------------------------------------------ команды

  function retry(trackId: number) {
    if (!leader) return void tabs.post({ trackId, type: 'retry' });
    const f = files.get(trackId);
    if (!f || f.state !== 'failed') return;
    Object.assign(f, {
      attempts: 0,
      error: null,
      next_attempt_at: null,
      state: 'queued',
    } satisfies Partial<OfflineFile>);
    track(persist(f));
    pump();
  }

  function setPaused(value: boolean) {
    if (!leader) return void tabs.post({ type: 'paused', value });
    paused = value;
    pump();
  }

  /** Файл не воспроизвёлся (повреждён): запись возвращается в очередь, файл удаляется, плеер идёт в сеть. */
  async function markBroken(trackId: number) {
    const f = files.get(trackId);
    if (!f) return;
    if (inflight.delete(trackId)) abortDownload(trackId);
    await filesReleased();
    await storage.remove(String(trackId)).catch(() => undefined);
    Object.assign(f, {
      attempts: 0,
      bytes_done: 0,
      completed_at: null,
      error: 'corrupt',
      next_attempt_at: null,
      state: 'queued',
    } satisfies Partial<OfflineFile>);
    quotaError = false;
    await persist(f);
    await refreshUsage();
    pump();
  }

  /** Прерывает загрузки, снимает все закрепления и удаляет все файлы и записи. */
  async function wipe() {
    for (const id of [...inflight]) abortDownload(id);
    inflight.clear();
    pins.clear();
    pinsDirty = true;
    files.clear();
    order = new Map();
    await filesReleased();
    for (const name of await storage.list()) await storage.remove(name).catch(() => undefined);
    await db.offlineClear();
    quotaError = false;
  }

  async function removeAll() {
    if (!leader) return void tabs.post({ type: 'removeAll' });
    await wipe();
    await refreshUsage();
    pump();
  }

  return {
    /** Загружает закрепления и файлы из IndexedDB; затем (когда вкладка станет лидером) сверяет и качает. */
    async start() {
      const loaded = await reloadFromDb();
      for (const f of loaded.files) files.set(f.track_id, f);
      publish(true);
      unsubscribers.push(downloader.on(m => void track(onMessage(m))));
      tabs.onMessage(onTabMessage);
      tabs.lead(() => {
        leading = becomeLeader();
        track(leading);
      });
      // Без Web Locks лидерство берётся сразу — дожидаемся его, чтобы вызывающий видел готовое состояние.
      if (leading) await leading;
    },
    /** Останавливает работу вкладки: загрузки прерываются (при следующем старте докачаются), записи остаются. */
    stop() {
      stopped = true;
      clearTimeout(wake);
      clearTimeout(reconcileTimer);
      clearTimeout(broadcastTimer);
      clearTimeout(progressTimer);
      progressTimer = undefined;
      for (const id of inflight) abortDownload(id);
      inflight.clear();
      for (const off of unsubscribers.splice(0)) off();
      tabs.close();
    },
    /** Записывает состояние всех файлов в IndexedDB сейчас (`pagehide`/`freeze`: по таймеру можно не успеть). */
    flush: () => track(Promise.all([...files.values()].map(persist))).then(() => undefined),
    pin,
    unpin,
    isPinned: (kind: PinKind, id: number) => pins.has(key(kind, id)),
    retry,
    setPaused,
    markBroken: (trackId: number) => (leader ? markBroken(trackId) : void tabs.post({ trackId, type: 'broken' })),
    removeAll,
    /** Выход из учётной записи: всё, что на устройстве, удаляется (менеджер после этого неработоспособен). */
    async clear() {
      this.stop();
      await wipe(); // ждёт, пока воркер освободит файлы
      status.setState({ ...initialOfflineStatus(status.getState().supported) }, true);
    },
    /** Для тестов: дождаться всех фоновых операций менеджера. */
    async settled() {
      while (queued.size > 0) await Promise.allSettled([...queued]);
    },
  };
}

export type OfflineManager = ReturnType<typeof createOfflineManager>;
