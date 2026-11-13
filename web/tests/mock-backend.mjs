// Минимальный мок Rust-бэкенда для Playwright: серверные компоненты Next ходят на BACKEND_URL
// с сервера, поэтому `page.route` их не перехватывает. Состояние живёт в памяти процесса.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4010);

// Аудио для стрима: 5 секунд синуса 440 Гц (WAV, 8 кГц, 16 бит, моно), генерируется при старте.
const WAV = (() => {
  const rate = 8000;
  const seconds = 5;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
})();

// WAV с начала `startSec` (для перекодируемых треков: поток без Range, перемотка через `?t=`).
function wavFrom(startSec) {
  const skip = Math.min(Math.floor(startSec * 8000), 8000 * 5) * 2;
  const data = WAV.subarray(44 + skip);
  const head = Buffer.from(WAV.subarray(0, 44));
  head.writeUInt32LE(36 + data.length, 4);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Треки, которые стрим отдаёт с ошибкой (как настоящий бэкенд).
const STREAM_ERRORS = { 1034: [503, 'ffmpeg_missing'] };
const RH = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const PABLO = 'aaaaaaaa-0000-4000-8000-000000000102';

let seq = 0;
const artists = new Map();
const albums = new Map();
const tracks = new Map();
const torrents = new Map();
let trackSources = [];
let requestLog = [];
const MASK = '••••';
const defaultSettings = () => ({
  matching: { accept: 0.8, confirm: 0.65 },
  playback: { prefetch_next: true, transcode_alac: false, transcode_lossy_codec: 'opus' },
  providers: {
    rutracker: { cookie: null, music_forums_regex: null, password: 'secret-pw', proxy: null, username: 'bob' },
    torznab: null,
    tpb_enabled: true,
  },
  search: {
    format_prefs: ['flac', 'alac', 'mp3_320', 'mp3_v0', 'aac', 'ape_wv', 'mp3_other'],
    max_candidates: 8,
    skip_secondary_types: ['EP', 'Compilation', 'Live', 'Remix', 'DJ-mix', 'Demo', 'Soundtrack', 'Mixtape/Street', 'Spokenword', 'Interview', 'Audiobook', 'Audio drama'],
  },
  storage: { cache_limit_gb: 50, seed_ratio: null, seeding: false },
});
let settings = defaultSettings();
function maskedSettings() {
  const v = structuredClone(settings);
  const r = v.providers.rutracker;
  if (r?.password) r.password = MASK;
  if (r?.cookie) r.cookie = MASK;
  if (v.providers.torznab?.api_key) v.providers.torznab.api_key = MASK;
  return v;
}
// Слияние как на бэкенде: объекты рекурсивно, пустой секрет и маска не меняют значение.
function mergeSettings(target, patch, path = []) {
  const secret = ['providers.torznab.api_key', 'providers.rutracker.password', 'providers.rutracker.cookie'];
  for (const [k, v] of Object.entries(patch)) {
    const p = [...path, k].join('.');
    if (secret.includes(p) && (v === '' || v === MASK)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      mergeSettings(target[k], v, [...path, k]);
    } else target[k] = v;
  }
}

function addArtist(a) {
  artists.set(a.id, { disambiguation: null, in_library: true, ...a });
}

function addAlbum(a, trackDefs) {
  albums.set(a.id, {
    artist_id: 1,
    cover_url: null,
    in_library: true,
    primary_type: 'Album',
    year: 1995,
    ...a,
    order: ++seq,
  });
  trackDefs.forEach((t, i) =>
    tracks.set(t.id, {
      album_id: a.id,
      artist_id: 1,
      disc_no: 1,
      duration_ms: 240000,
      in_library: a.in_library ?? true,
      mbid_recording: `f0000000-0000-4000-8000-${String(t.id).padStart(12, '0')}`,
      position: i + 1,
      status: 'adding',
      status_reason: null,
      ...t,
      order: ++seq,
    }),
  );
}

function seed() {
  artists.clear();
  albums.clear();
  tracks.clear();
  seq = 0;
  addArtist({ id: 1, mbid: RH, name: 'Radiohead' });
  // Импорт дискографии: ждём MusicBrainz (повтор) и неудача (после исчерпания попыток).
  addArtist({
    id: 20,
    import: { attempt: 2, error: 'MusicBrainz is unavailable: rate limited', max_attempts: 8, progress: null, retry_at: new Date(Date.now() + 150_000).toISOString(), state: 'retrying' },
    mbid: 'aaaaaaaa-0000-4000-8000-000000000020',
    name: 'Retry Artist',
  });
  addArtist({
    id: 22,
    import: {
      attempt: 1, error: null, max_attempts: 8, progress: {
        current: 'Recovery', done: 3, imported: 2, log: [
          { at: '2026-11-12T14:00:00Z', text: 'Found 12 release groups (albums and EPs) in 2.1s' },
          { at: '2026-11-12T14:00:03Z', text: 'Skipped "Live Show": type Live' },
          { at: '2026-11-12T14:00:06Z', text: 'Added "Relapse" (2.4s)' },
        ], phase: 'albums', skipped: 1,
        total: 12,
      }, retry_at: null,
      state: 'importing',
    },
    mbid: 'aaaaaaaa-0000-4000-8000-000000000022',
    name: 'Progress Artist',
  });
  addArtist({
    id: 21,
    import: { attempt: 8, error: 'MusicBrainz is unavailable: rate limited', max_attempts: 8, retry_at: null, state: 'failed' },
    mbid: 'aaaaaaaa-0000-4000-8000-000000000021',
    name: 'Failed Artist',
  });
  for (let i = 0; i < 52; i++) addAlbum({ id: 300 + i, mbid: crypto.randomUUID(), title: `Filler ${i}` }, []);
  addAlbum({ id: 101, mbid: 'aaaaaaaa-0000-4000-8000-000000000101', title: 'Kid A', year: 2000 }, [
    { id: 1011, title: 'Everything in Its Right Place' },
  ]);
  addAlbum({ id: 102, in_library: false, mbid: PABLO, title: 'Pablo Honey', year: 1993 }, [
    { id: 1021, in_library: true, status: 'found', title: 'Creep' },
    { id: 1022, in_library: false, title: 'Anyone Can Play Guitar' },
  ]);
  // Альбом для тестов плеера: сам вне библиотеки, но его треки в библиотеке (как «Pablo Honey»).
  addAlbum(
    { id: 103, in_library: false, mbid: 'aaaaaaaa-0000-4000-8000-000000000103', title: 'Player Test', year: 2001 },
    [
      { duration_ms: 5000, id: 1031, in_library: true, status: 'found', title: 'Song One' },
      { duration_ms: 5000, id: 1034, in_library: true, status: 'found', title: 'Broken Format' },
      { duration_ms: 5000, id: 1032, in_library: true, status: 'found', title: 'Song Two' },
      { duration_ms: 5000, id: 1033, in_library: true, status: 'ready', title: 'Song Three' },
      { duration_ms: 5000, id: 1035, in_library: true, status: 'adding', title: 'Not Yet' },
    ],
  );
  // Альбом для перекодируемого воспроизведения (CUE-образ / APE): поток без Range, перемотка через `?t=`.
  addAlbum(
    { id: 105, in_library: false, mbid: 'aaaaaaaa-0000-4000-8000-000000000105', title: 'Transcode Test', year: 2003 },
    [{ duration_ms: 5000, id: 1051, in_library: true, playback: 'transcode', status: 'found', title: 'Image Track' }],
  );
  addAlbum({ id: 100, mbid: 'aaaaaaaa-0000-4000-8000-000000000100', title: 'The Bends' }, [
    { id: 1001, title: 'Planet Telex' },
    { id: 1002, status: 'found', title: 'High and Dry' },
    { id: 1003, status: 'not_found', status_reason: 'no_match', title: 'Fake Plastic Trees' },
  ]);
  // Альбом для тестов источников (сам вне библиотеки, треки в библиотеке).
  addAlbum(
    { id: 104, in_library: false, mbid: 'aaaaaaaa-0000-4000-8000-000000000104', title: 'Sources Test', year: 2002 },
    [
      { id: 1041, in_library: true, status: 'found', title: 'Doubtful Song' },
      { id: 1042, in_library: true, status: 'not_found', status_reason: 'no_match', title: 'Missing Song' },
      { id: 1043, in_library: true, status: 'not_found', status_reason: 'no_match', title: 'Retry Song' },
    ],
  );
  torrents.clear();
  trackSources = [];
  requestLog = [];
  settings = defaultSettings();
  const files = ['01 Doubtful Song.flac', '02 Other Take.flac', '03 Missing Song.flac'].map((name, i) => ({
    ext: 'flac',
    file_index: i,
    path: `Sources Test/${name}`,
    size_bytes: 30_000_000 + i,
  }));
  torrents.set(900, {
    album_id: 104,
    files,
    id: 900,
    info_hash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    kind: 'album',
    leechers: 1,
    meta_status: 'ok',
    seeders: 12,
    size_bytes: 90_000_000,
    source: 'tpb',
    title: 'Sources Test [FLAC]',
  });
  trackSources.push(
    {
      file_index: 0,
      id: 1,
      is_primary: true,
      match_score: 0.55,
      needs_confirmation: true,
      torrent_id: 900,
      track_id: 1041,
    },
    {
      file_index: 1,
      id: 2,
      is_primary: false,
      match_score: 0.5,
      needs_confirmation: false,
      torrent_id: 900,
      track_id: 1041,
    },
  );
}
seed();

const primaryOf = id => trackSources.find(s => s.track_id === id && s.is_primary);
const torrentDto = t => {
  const rest = { ...t };
  delete rest.files;
  delete rest.album_id;
  return rest;
};
const sourceDto = s => {
  const t = torrents.get(s.torrent_id);
  const f = t.files.find(x => x.file_index === s.file_index);
  return {
    file_index: s.file_index,
    id: s.id,
    is_primary: s.is_primary,
    match_score: s.match_score,
    needs_confirmation: s.needs_confirmation,
    path: f.path,
    size_bytes: f.size_bytes,
    torrent: torrentDto(t),
  };
};

const artistName = id => artists.get(id)?.name ?? '';
const albumTracks = id => [...tracks.values()].filter(t => t.album_id === id);

function albumDto(a) {
  const ts = albumTracks(a.id);
  const count = s => ts.filter(t => t.status === s).length;
  return {
    artist_id: a.artist_id,
    artist_name: artistName(a.artist_id),
    cover_url: a.cover_url,
    id: a.id,
    in_library: a.in_library,
    mbid: a.mbid,
    primary_type: a.primary_type,
    status_counts: {
      adding: count('adding'),
      found: count('found'),
      not_found: count('not_found'),
      ready: count('ready'),
    },
    title: a.title,
    track_count: ts.length,
    year: a.year,
  };
}

function artistDto(a) {
  const own = [...albums.values()].filter(al => al.artist_id === a.id);
  const partial = own.filter(al => al.in_library || albumTracks(al.id).some(t => t.in_library));
  return {
    album_count: partial.length,
    disambiguation: a.disambiguation,
    id: a.id,
    import: a.import ?? null,
    in_library: a.in_library,
    mbid: a.mbid,
    name: a.name,
    track_count: [...tracks.values()].filter(t => t.in_library && albums.get(t.album_id)?.artist_id === a.id).length,
  };
}

function trackDto(t) {
  const al = albums.get(t.album_id);
  return {
    album_id: t.album_id,
    album_title: al.title,
    artist_id: t.artist_id,
    artist_name: artistName(t.artist_id),
    cover_url: al.cover_url,
    disc_no: t.disc_no,
    duration_ms: t.duration_ms,
    id: t.id,
    in_library: t.in_library,
    mbid_recording: t.mbid_recording,
    needs_confirmation: primaryOf(t.id)?.needs_confirmation ?? false,
    play_count: t.play_count ?? 0,
    playback: t.playback ?? 'direct',
    position: t.position,
    status: t.status,
    status_reason: t.status_reason,
    title: t.title,
  };
}

function page(items, url, limitDefault, map) {
  const limit = Number(url.searchParams.get('limit') ?? limitDefault);
  const start = Number(url.searchParams.get('cursor') || 0);
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: slice.map(map), next_cursor: next };
}

const recent = m => [...m.values()].filter(x => x.in_library).sort((a, b) => b.order - a.order);

function send(res, status, body) {
  res.writeHead(status, {
    'access-control-allow-headers': 'content-type, authorization, range',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, accept-ranges, content-length',
    'content-type': 'application/json',
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const err = (res, status, code, message) => send(res, status, { error: { code, message } });

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);

  if (p === '/__reset') {
    seed();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/health') return send(res, 200, { db: true, status: 'ok', version: 'mock' });

  let sm;
  if ((req.method === 'GET' || req.method === 'HEAD') && (sm = p.match(/^\/api\/tracks\/(\d+)\/stream$/))) {
    const id = Number(sm[1]);
    const t = tracks.get(id);
    if (STREAM_ERRORS[id]) return err(res, STREAM_ERRORS[id][0], STREAM_ERRORS[id][1], 'stream error');
    if (!t || !['found', 'ready'].includes(t.status)) return err(res, 409, 'track_not_playable', 'not playable');
    if (t.playback === 'transcode') {
      const start = Number(url.searchParams.get('t') ?? 0);
      if (req.method === 'GET') requestLog.push({ method: 'GET', path: p, query: url.search });
      const body = wavFrom(start);
      res.writeHead(200, {
        'accept-ranges': 'none',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-length': body.length,
        'content-type': 'audio/wav',
        'x-nimbus-duration-ms': '5000',
        'x-nimbus-transcode': '1',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const size = WAV.length;
    const headers = {
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'audio/wav',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
    }
    const partial = Boolean(range);
    res.writeHead(partial ? 206 : 200, {
      ...headers,
      'content-length': end - start + 1,
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    return res.end(req.method === 'HEAD' ? undefined : WAV.subarray(start, end + 1));
  }

  // Возвращает артиста 21 в состояние «импорт не удался» (без полного сброса: тесты идут параллельно).
  if (p === '/__artist-import-failed') {
    const a = artists.get(21);
    if (a) a.import = { attempt: 8, error: 'MusicBrainz is unavailable: rate limited', max_attempts: 8, retry_at: null, state: 'failed' };
    return send(res, 200, { ok: true });
  }
  if (p === '/__log') return send(res, 200, requestLog);

  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, maskedSettings());
  if (p === '/api/settings' && req.method === 'PUT') {
    const body = await readJson(req);
    requestLog.push({ body, method: 'PUT', path: p });
    if (body?.storage?.cache_limit_gb === 0)
      return err(res, 400, 'invalid_settings', 'cache_limit_gb must be at least 1');
    mergeSettings(settings, body ?? {});
    return send(res, 200, maskedSettings());
  }
  if (p === '/api/storage') {
    return send(res, 200, {
      files: 12,
      limit_bytes: settings.storage.cache_limit_gb * 1024 ** 3,
      torrents_active: 1,
      used_bytes: 3 * 1024 ** 3,
    });
  }
  if (p === '/api/settings/reimport-artists' && req.method === 'POST') {
    requestLog.push({ method: 'POST', path: p });
    return send(res, 200, { queued: 3 });
  }
  if (p === '/api/settings/providers/test' && req.method === 'POST') {
    const body = await readJson(req);
    requestLog.push({ body, method: 'POST', path: p });
    if (body?.provider === 'torznab' && !settings.providers.torznab)
      return err(res, 400, 'not_configured', 'provider is not configured');
    return send(res, 200, { message: 'Найдено раздач: 25', ok: true, sample_count: 25 });
  }
  const importMatch = req.method === 'POST' ? p.match(/^\/api\/artists\/(\d+)\/import$/) : null;
  if (importMatch) {
    requestLog.push({ method: 'POST', path: p });
    const a = artists.get(Number(importMatch[1]));
    if (!a) return err(res, 404, 'not_found', 'artist not found');
    a.import = { attempt: 1, error: null, max_attempts: 8, retry_at: null, state: 'importing' };
    return send(res, 202, {});
  }
  if (req.method === 'POST' && (sm = p.match(/^\/api\/tracks\/(\d+)\/played$/))) {
    requestLog.push({ method: 'POST', path: p });
    const t = tracks.get(Number(sm[1]));
    if (!t) return err(res, 404, 'not_found', 'track not found');
    t.play_count = (t.play_count ?? 0) + 1;
    return send(res, 200, { play_count: t.play_count });
  }
  if (req.method === 'GET' && p === '/api/playlists') {
    return send(res, 200, {
      items: [
        { cover_url: null, created_at: null, id: 'favorites', kind: 'favorites', last_used_at: null, name: 'Favorites', track_count: 0 },
      ],
    });
  }
  if (req.method === 'POST' && /^\/api\/tracks\/\d+\/prefetch$/.test(p)) {
    requestLog.push({ method: 'POST', path: p });
    return send(res, 202, { state: 'started' });
  }

  {
    let m;
    const albumTorrents = id => [...torrents.values()].filter(t => t.album_id === id);
    if (req.method === 'GET' && (m = p.match(/^\/api\/albums\/(\d+)\/torrents$/))) {
      if (!albums.has(Number(m[1]))) return err(res, 404, 'not_found', 'album not found');
      return send(
        res,
        200,
        albumTorrents(Number(m[1])).map(t => ({
          files_count: t.files.length,
          matched_tracks: new Set(trackSources.filter(s => s.torrent_id === t.id).map(s => s.track_id)).size,
          rank_score: 0.8,
          torrent: torrentDto(t),
          verified: true,
        })),
      );
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/torrents\/(\d+)\/files$/))) {
      const t = torrents.get(Number(m[1]));
      if (!t) return err(res, 404, 'not_found', 'torrent not found');
      return send(
        res,
        200,
        t.files.map(f => ({
          ...f,
          matched_track_id:
            trackSources
              .filter(s => s.torrent_id === t.id && s.file_index === f.file_index)
              .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0]?.track_id ?? null,
        })),
      );
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/tracks\/(\d+)\/sources$/))) {
      const list = trackSources
        .filter(s => s.track_id === Number(m[1]))
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
      return send(res, 200, list.map(sourceDto));
    }
    if (req.method === 'PUT' && (m = p.match(/^\/api\/tracks\/(\d+)\/source$/))) {
      const id = Number(m[1]);
      const body = await readJson(req);
      requestLog.push({ body, method: 'PUT', path: p });
      const t = tracks.get(id);
      if (!t) return err(res, 404, 'not_found', 'track not found');
      let src;
      if (body?.source_id) src = trackSources.find(x => x.id === body.source_id && x.track_id === id);
      else if (body?.torrent_id !== undefined && body?.file_index !== undefined) {
        src = trackSources.find(
          x => x.track_id === id && x.torrent_id === body.torrent_id && x.file_index === body.file_index,
        );
        if (!src) {
          src = {
            file_index: body.file_index,
            id: 100 + trackSources.length,
            is_primary: false,
            match_score: 1,
            needs_confirmation: false,
            torrent_id: body.torrent_id,
            track_id: id,
          };
          trackSources.push(src);
        }
      } else return err(res, 400, 'bad_source', 'bad body');
      if (!src) return err(res, 404, 'not_found', 'source not found');
      trackSources.filter(x => x.track_id === id).forEach(x => (x.is_primary = x === src));
      t.status = 'found';
      t.status_reason = null;
      return send(res, 200, sourceDto(src));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tracks\/(\d+)\/sources\/(\d+)\/confirm$/))) {
      requestLog.push({ method: 'POST', path: p });
      const src = trackSources.find(x => x.id === Number(m[2]) && x.track_id === Number(m[1]));
      if (!src) return err(res, 404, 'not_found', 'source not found');
      src.needs_confirmation = false;
      return send(res, 200, sourceDto(src));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tracks\/(\d+)\/retry$/))) {
      requestLog.push({ method: 'POST', path: p });
      const t = tracks.get(Number(m[1]));
      if (!t) return err(res, 404, 'not_found', 'track not found');
      t.status = 'adding';
      return send(res, 202, { queued: true, tracks_reset: 1 });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/albums\/(\d+)\/retry$/))) {
      requestLog.push({ method: 'POST', path: p });
      albumTracks(Number(m[1]))
        .filter(t => t.status === 'not_found')
        .forEach(t => (t.status = 'adding'));
      return send(res, 202, { queued: true, tracks_reset: 1 });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/albums\/(\d+)\/torrents$/))) {
      const body = await readJson(req);
      requestLog.push({ body, method: 'POST', path: p });
      if (!/^magnet:\?xt=urn:btih:[0-9a-f]{40}/i.test(body?.magnet ?? ''))
        return err(res, 400, 'invalid_magnet', 'not a valid magnet link');
      const id = 901 + torrents.size;
      torrents.set(id, {
        album_id: Number(m[1]),
        files: [],
        id,
        info_hash: body.magnet.slice(20, 60),
        kind: 'unknown',
        leechers: null,
        meta_status: 'pending',
        seeders: null,
        size_bytes: null,
        source: 'manual',
        title: 'Свой magnet',
      });
      return send(res, 202, { queued: true, torrent: torrentDto(torrents.get(id)) });
    }
  }

  if (req.method === 'GET') {
    if (p === '/api/library/artists') return send(res, 200, page(recent(artists), url, 50, artistDto));
    if (p === '/api/library/albums') return send(res, 200, page(recent(albums), url, 50, albumDto));
    if (p === '/api/library/tracks') {
      const statuses = (url.searchParams.get('status') ?? '').split(',').filter(Boolean);
      const items = recent(tracks).filter(t => statuses.length === 0 || statuses.includes(t.status));
      return send(res, 200, page(items, url, 100, trackDto));
    }
    let m;
    if ((m = p.match(/^\/api\/albums\/(\d+)$/))) {
      const id = Number(m[1]);
      if (id === 666) return err(res, 500, 'internal', 'boom');
      const a = albums.get(id);
      if (!a) return err(res, 404, 'not_found', 'album not found');
      const ts = albumTracks(id).sort((x, y) => x.disc_no - y.disc_no || x.position - y.position);
      return send(res, 200, {
        album: albumDto(a),
        artist: artistDto(artists.get(a.artist_id)),
        tracks: ts.map(trackDto),
      });
    }
    if ((m = p.match(/^\/api\/artists\/(\d+)$/))) {
      const a = artists.get(Number(m[1]));
      if (!a) return err(res, 404, 'not_found', 'artist not found');
      const own = [...albums.values()].filter(
        al => al.artist_id === a.id && (al.in_library || albumTracks(al.id).some(t => t.in_library)),
      );
      return send(res, 200, { albums: own.sort((x, y) => x.year - y.year).map(albumDto), artist: artistDto(a) });
    }
    if ((m = p.match(/^\/api\/tracks\/(\d+)$/))) {
      const t = tracks.get(Number(m[1]));
      return t ? send(res, 200, trackDto(t)) : err(res, 404, 'not_found', 'track not found');
    }
  }

  if (req.method === 'POST' && p === '/api/library') {
    const body = await readJson(req);
    if (!body?.type || !body?.mbid) return err(res, 400, 'bad_request', 'bad body');
    if (body.type === 'artist') {
      addArtist({ id: 1, mbid: body.mbid, name: 'Radiohead' });
      return send(res, 202, { id: 1, status: 'importing', type: 'artist' });
    }
    if (body.type === 'album') {
      let a = [...albums.values()].find(x => x.mbid === body.mbid);
      if (a?.in_library) return send(res, 200, { id: a.id, status: 'exists', type: 'album' });
      if (a) {
        a.in_library = true;
        a.order = ++seq;
        albumTracks(a.id).forEach(t => (t.in_library = true));
        return send(res, 201, { id: a.id, status: 'added', type: 'album' });
      }
      const id = 200;
      addAlbum({ id, mbid: body.mbid, title: 'OK Computer', year: 1997 }, [
        { id: 2001, title: 'Airbag' },
        { id: 2002, title: 'Paranoid Android' },
        { id: 2003, title: 'Subterranean Homesick Alien' },
      ]);
      return send(res, 201, { id, status: 'added', type: 'album' });
    }
    if (body.type === 'track') {
      const t = [...tracks.values()].find(x => x.mbid_recording === body.mbid);
      if (!t) return err(res, 422, 'recording_not_in_release', 'not in release');
      if (t.in_library) return send(res, 200, { id: t.id, status: 'exists', type: 'track' });
      t.in_library = true;
      t.order = ++seq;
      return send(res, 201, { id: t.id, status: 'added', type: 'track' });
    }
    return err(res, 400, 'bad_request', 'bad type');
  }

  let m;
  if (req.method === 'DELETE' && (m = p.match(/^\/api\/library\/(artist|album|track)\/(\d+)$/))) {
    const id = Number(m[2]);
    if (m[1] === 'album') {
      const a = albums.get(id);
      if (!a) return err(res, 404, 'not_found', 'album not found');
      a.in_library = false;
      albumTracks(id).forEach(t => (t.in_library = false));
    } else if (m[1] === 'track') {
      const t = tracks.get(id);
      if (!t) return err(res, 404, 'not_found', 'track not found');
      t.in_library = false;
    } else {
      const a = artists.get(id);
      if (!a) return err(res, 404, 'not_found', 'artist not found');
      a.in_library = false;
    }
    return send(res, 204);
  }

  err(res, 404, 'not_found', 'no such route');
}).listen(PORT, () => console.log(`mock backend on :${PORT}`));
