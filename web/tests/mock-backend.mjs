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

// Треки, которые стрим отдаёт с ошибкой (как настоящий бэкенд).
const STREAM_ERRORS = { 1034: [415, 'transcode_required'] };
const RH = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const PABLO = 'aaaaaaaa-0000-4000-8000-000000000102';

let seq = 0;
const artists = new Map();
const albums = new Map();
const tracks = new Map();

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
  addAlbum({ id: 100, mbid: 'aaaaaaaa-0000-4000-8000-000000000100', title: 'The Bends' }, [
    { id: 1001, title: 'Planet Telex' },
    { id: 1002, status: 'found', title: 'High and Dry' },
    { id: 1003, status: 'not_found', status_reason: 'no_match', title: 'Fake Plastic Trees' },
  ]);
}
seed();

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
