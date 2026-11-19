// Мок контрактов шагов 26, 32, 33 (приобретение, закрепления, загрузки движка, задачи) над данными `FakeSyncServer`:
// состояние альбома вычисляется по статусам его треков, как на настоящем сервере.
import type { FakeSyncServer } from '../src/test/factories';
import { makeAlbum, makeArtist, makeTrack } from '../src/test/factories';

type Row = { id: number } & Record<string, unknown>;
type PinState = 'queued' | 'downloading' | 'done' | 'waiting_source' | 'failed';
type Pin = { state: PinState; done: number; total: number };
type Torrent = {
  info_hash: string;
  name: string;
  state: 'downloading' | 'seeding' | 'paused';
  total: number;
  done: number;
};
type Job = { id: number; kind: string; payload: Record<string, unknown>; last_error: string; attempts: number };

export type AcquisitionDeps = {
  server: () => FakeSyncServer;
  json: (status: number, body?: unknown) => Response;
  broadcast: (event: unknown) => void;
  poke: () => void;
  now: () => string;
};

const MB = 1024 * 1024;

export function createAcquisitionMock(deps: AcquisitionDeps) {
  const pins = new Map<number, Pin>();
  const attempts = new Map<number, number>();
  let paused = false;
  let torrents: Torrent[] = [];
  let jobs: Job[] = [];
  /** Отчёт проверки инвариантов непуст (`POST /__test/acquisition/stuck`). */
  let stuck = false;
  let pinFail = false;

  const err = (status: number, code: string, message: string) => deps.json(status, { error: { code, message } });
  const tracksOf = (albumId: number) =>
    deps
      .server()
      .all('track')
      .filter(t => t.album_id === albumId && t.in_library === true) as Row[];
  const albums = () =>
    deps
      .server()
      .all('album')
      .filter(a => a.in_library === true) as Row[];

  const changed = (albumId: number) => deps.broadcast({ album_id: albumId, type: 'acquisition.changed' });

  function view(album: Row) {
    const tracks = tracksOf(album.id);
    const count = (s: string) => tracks.filter(t => t.status === s).length;
    const t = {
      adding: count('adding'),
      found: count('found'),
      not_found: count('not_found'),
      ready: count('ready'),
      total: tracks.length,
    };
    const pin = pins.get(album.id);
    let state: string;
    if (t.adding > 0) state = 'searching';
    else if (pin && (pin.state === 'downloading' || (pin.state === 'queued' && pin.done > 0))) state = 'downloading';
    else if (t.not_found > 0 && t.found + t.ready > 0) state = 'partial';
    else if (t.not_found > 0) state = 'missing';
    else if (t.ready === t.total && t.total > 0) state = 'downloaded';
    else state = 'available';
    const artist = deps.server().get('artist', album.artist_id as number);
    const reason =
      tracks.find(x => x.status === 'not_found' && x.status_reason)?.status_reason ??
      (t.not_found > 0 ? 'no_torrents' : null);
    const tried = attempts.get(album.id) ?? (t.not_found > 0 ? 1 : 0);
    return {
      active_jobs: t.adding > 0 ? 1 : 0,
      album: {
        artist: { id: album.artist_id, name: artist?.name ?? 'Unknown' },
        cover_url: null,
        id: album.id,
        title: album.title,
        year: album.year ?? null,
      },
      download: pin
        ? {
            bytes_done: pin.done,
            bytes_total: pin.total,
            down_bps: pin.state === 'downloading' ? MB : 0,
            error: pin.state === 'failed' ? 'stalled' : null,
            peers: 2,
            pinned: true,
            state: pin.state,
          }
        : null,
      reason: t.not_found > 0 ? reason : null,
      search: {
        attempts: tried,
        candidates: 0,
        last_finished_at: tried ? deps.now() : null,
        last_outcome: t.not_found > 0 ? (reason ?? 'no_torrents') : null,
        next_retry_at: t.not_found > 0 ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
        provider_errors: [],
      },
      state,
      tracks: t,
    };
  }

  const sortKey = (v: ReturnType<typeof view>) => (v.state === 'searching' ? 0 : 1) * 1e9 + v.album.id;

  function summary() {
    const s = {
      available: 0,
      downloaded: 0,
      downloading: 0,
      failed_jobs: jobs.length,
      missing: 0,
      partial: 0,
      searching: 0,
    };
    for (const a of albums()) s[view(a).state as keyof typeof s]++;
    return s;
  }

  const setStatus = (albumId: number, from: string, to: string, reason: string | null = null) => {
    for (const t of tracksOf(albumId)) {
      if (t.status === from) deps.server().upsert('track', { ...t, status: to, status_reason: reason });
    }
  };

  /** Закрепление альбома → поля `pin`/`pin_error` его треков в синхронизации (как триггеры `pinned_tracks`). */
  const syncPins = (albumId: number) => {
    const pin = pins.get(albumId);
    for (const t of tracksOf(albumId)) {
      const state: PinState | null = !pin
        ? null
        : pin.state === 'done' || t.status === 'found' || t.status === 'ready'
          ? pin.state
          : 'waiting_source';
      const error = state === 'failed' ? 'stalled' : null;
      if ((t.pin ?? null) !== state || (t.pin_error ?? null) !== error)
        deps.server().upsert('track', { ...t, pin: state, pin_error: error });
    }
    deps.poke();
  };

  async function route(req: Request, path: string): Promise<Response | null> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const m = req.method;

    if (path === '/api/acquisition' && m === 'GET') {
      const states = (q.get('state') ?? '').split(',').filter(Boolean);
      const ids = (q.get('album_ids') ?? '').split(',').filter(Boolean).map(Number);
      const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50)));
      const offset = Number(q.get('cursor') ?? 0);
      const all = albums()
        .map(view)
        .filter(v => (!states.length || states.includes(v.state)) && (!ids.length || ids.includes(v.album.id)))
        .sort((a, b) => sortKey(a) - sortKey(b));
      const items = all.slice(offset, offset + limit);
      return deps.json(200, { items, next_cursor: offset + limit < all.length ? String(offset + limit) : null });
    }
    if (path === '/api/acquisition/summary') return deps.json(200, summary());
    if (path === '/api/acquisition/retry' && m === 'POST') {
      const body = (await req.json()) as { scope: string; album_ids?: number[] };
      const targets =
        body.scope === 'albums'
          ? albums().filter(a => body.album_ids?.includes(a.id))
          : albums().filter(a => ['missing', 'partial'].includes(view(a).state));
      for (const a of targets) {
        attempts.set(a.id, 0);
        setStatus(a.id, 'not_found', 'adding');
        changed(a.id);
      }
      deps.poke();
      return deps.json(202, { queued: targets.length });
    }

    const album = path.match(/^\/api\/albums\/(\d+)\/download$/);
    if (album) {
      const id = Number(album[1]);
      if (!albums().some(a => a.id === id)) return err(404, 'not_found', 'no such album');
      if (m === 'POST') {
        if (pinFail) return err(500, 'internal', 'pin failed');
        const found = tracksOf(id).filter(t => t.status === 'found').length;
        if (!pins.has(id)) pins.set(id, { done: 0, state: found > 0 ? 'queued' : 'waiting_source', total: 100 * MB });
        syncPins(id);
        changed(id);
        return deps.json(200, { pinned: tracksOf(id).length });
      }
      if (m === 'DELETE') {
        pins.delete(id);
        if (q.get('delete_files') === 'true') setStatus(id, 'ready', 'found');
        syncPins(id);
        changed(id);
        return deps.json(204);
      }
    }

    if (path === '/api/downloads' && m === 'GET') {
      const queue = { downloading: 0, failed: 0, queued: 0, waiting_source: 0 };
      for (const p of pins.values()) if (p.state !== 'done') queue[p.state]++;
      return deps.json(200, {
        down_bps: 0,
        paused,
        queue,
        torrents: torrents.map(t => ({
          down_bps: t.state === 'downloading' && !paused ? MB : 0,
          error: null,
          finished: false,
          info_hash: t.info_hash,
          name: t.name,
          peers: 3,
          progress_bytes: t.done,
          seeds: 1,
          state: paused && t.state === 'downloading' ? 'paused' : t.state,
          total_bytes: t.total,
          up_bps: 0,
          uploaded_bytes: 0,
        })),
        up_bps: 0,
      });
    }
    if (path === '/api/downloads/pause-all' && m === 'POST') {
      paused = true;
      return deps.json(200, { paused });
    }
    if (path === '/api/downloads/resume-all' && m === 'POST') {
      paused = false;
      return deps.json(200, { paused });
    }
    const one = path.match(/^\/api\/downloads\/([^/]+)\/(pause|resume)$/);
    if (one && m === 'POST') {
      const t = torrents.find(x => x.info_hash === one[1]);
      if (!t) return err(404, 'not_found', 'no such torrent');
      t.state = one[2] === 'pause' ? 'paused' : 'downloading';
      return deps.json(204);
    }

    if (path === '/api/jobs' && m === 'GET') {
      const list = (q.get('state') === 'failed' ? jobs : []).map(j => ({
        attempts: j.attempts,
        id: j.id,
        kind: j.kind,
        last_error: j.last_error,
        max_attempts: 5,
        payload: j.payload,
        priority: 0,
        run_after: deps.now(),
        state: 'failed',
        updated_at: deps.now(),
      }));
      return deps.json(200, { counts: { failed: jobs.length, queued: 0, running: 0 }, jobs: list });
    }
    if (path === '/api/jobs/invariants' && m === 'GET') {
      const sections = stuck
        ? [
            {
              count: 2,
              invariant: 'I1',
              violations: [
                { detail: 'tracks in adding: 2', entity: 'album', id: 926, invariant: 'I1' },
                { detail: 'tracks in adding: 5', entity: 'album', id: 927, invariant: 'I1' },
              ],
            },
            {
              count: 1,
              invariant: 'I8',
              violations: [{ detail: 'storage: disk full', entity: 'pin', id: 9230, invariant: 'I8' }],
            },
          ]
        : [];
      return deps.json(200, { checked_at: deps.now(), grace_secs: 1800, sections, total: stuck ? 3 : 0 });
    }
    const retry = path.match(/^\/api\/jobs\/(\d+)\/retry$/);
    if (retry && m === 'POST') {
      const id = Number(retry[1]);
      if (!jobs.some(j => j.id === id)) return err(404, 'not_found', 'no such job');
      jobs = jobs.filter(j => j.id !== id);
      return deps.json(200, { id, state: 'queued' });
    }
    return null;
  }

  /** Служебные эндпоинты `/__test/*` этого модуля. */
  async function testRoute(req: Request, path: string): Promise<Response | null> {
    if (path === '/__test/acquisition') {
      const body = (await req.json().catch(() => ({}))) as { pinFail?: boolean; stuck?: boolean };
      pinFail = body.pinFail === true;
      stuck = body.stuck === true;
      seed();
      return deps.json(200, { ok: true });
    }
    if (path === '/__test/progress') {
      const b = (await req.json()) as { album_id: number; bytes_done: number; bytes_total?: number };
      const pin = pins.get(b.album_id) ?? { done: 0, state: 'queued' as PinState, total: 100 * MB };
      pin.total = b.bytes_total ?? pin.total;
      pin.done = b.bytes_done;
      pins.set(b.album_id, pin);
      if (pin.done >= pin.total) {
        pin.state = 'done';
        setStatus(b.album_id, 'found', 'ready');
        syncPins(b.album_id);
        changed(b.album_id);
      } else {
        const was = pin.state;
        pin.state = 'downloading';
        deps.broadcast({
          album_id: b.album_id,
          bytes_done: pin.done,
          bytes_total: pin.total,
          down_bps: MB,
          peers: 2,
          type: 'download.progress',
        });
        if (was !== 'downloading') {
          syncPins(b.album_id);
          changed(b.album_id);
        }
      }
      return deps.json(200, { state: pin.state });
    }
    if (path === '/__test/search-result') {
      const b = (await req.json()) as { album_id: number; found: boolean };
      if (b.found) setStatus(b.album_id, 'adding', 'found');
      else setStatus(b.album_id, 'adding', 'not_found', 'no_torrents');
      deps.poke();
      changed(b.album_id);
      return deps.json(200, { ok: true });
    }
    return null;
  }

  /**
   * Библиотека для сценариев «Загрузки» (артист 920): 921 не найден (reason dead_torrents), 922 найден частично,
   * 923 и 924 найдены, не скачаны, 925 скачан, 926 ищется. Плюс торренты движка и упавшая задача.
   */
  function seed() {
    pins.clear();
    attempts.clear();
    paused = false;
    const server = deps.server();
    server.upsert('artist', makeArtist({ added_at: deps.now(), id: 920, name: 'Acq Band' }));
    const album = (id: number, title: string, statuses: string[], reason: string | null = null) => {
      server.upsert('album', makeAlbum({ added_at: deps.now(), artist_id: 920, id, title, year: 2010 }));
      statuses.forEach((status, i) =>
        server.upsert(
          'track',
          makeTrack({
            added_at: deps.now(),
            album_id: id,
            artist_id: 920,
            id: id * 10 + i,
            position: i + 1,
            status: status as never,
            status_reason: status === 'not_found' ? reason : null,
            title: `${title} ${i + 1}`,
          } as never),
        ),
      );
    };
    album(921, 'Lost Record', ['not_found', 'not_found', 'not_found'], 'dead_torrents');
    album(922, 'Half Record', ['found', 'not_found'], 'no_match');
    album(923, 'Found One', ['found', 'found']);
    album(924, 'Found Two', ['found', 'found']);
    album(925, 'Safe Record', ['ready', 'ready']);
    album(926, 'Looking Now', ['adding', 'adding']);
    torrents = [
      { done: 20 * MB, info_hash: 'aaa111', name: 'Engine Torrent One', state: 'downloading', total: 100 * MB },
      { done: 100 * MB, info_hash: 'bbb222', name: 'Engine Torrent Two', state: 'seeding', total: 100 * MB },
    ];
    jobs = [
      { attempts: 5, id: 71, kind: 'discover_album', last_error: 'provider exploded', payload: { album_id: 921 } },
    ];
    deps.poke();
  }

  function reset() {
    pins.clear();
    attempts.clear();
    paused = false;
    torrents = [];
    jobs = [];
    stuck = false;
    pinFail = false;
  }

  return { reset, route, testRoute };
}
