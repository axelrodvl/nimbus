import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PinState } from '@/lib/api/acquisition';
import type { Track } from '@/lib/db/types';
import { makeTrack } from '@/test/factories';
import { albumServerState, isActiveServerDownload } from './server-state';

type Case = {
  name: string;
  tracks: { status: Track['status']; in_library: boolean; pin: PinState | null; pin_error: string | null }[];
  expected: { state: string; pinned: boolean; pin: PinState | null; pin_error: string | null } | null;
};

// Тот же файл проверяет бэкенд (`crates/db/tests/album_server_state.rs`): состояния обязаны совпадать.
const FIXTURE = join(__dirname, '..', '..', '..', '..', 'backend', 'crates', 'db', 'tests', 'fixtures');
const { cases } = JSON.parse(readFileSync(join(FIXTURE, 'album-server-state.json'), 'utf8')) as { cases: Case[] };

describe('albumServerState', () => {
  it.each(cases.map(c => [c.name, c] as const))('совпадает с сервером: %s', (_name, c) => {
    const tracks = c.tracks.map(t => makeTrack(t));
    const got = albumServerState(tracks);
    expect(got && { pin: got.pin, pin_error: got.pinError, pinned: got.pinned, state: got.state }).toEqual(c.expected);
  });

  it('примеры не пусты', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it('отсутствующие строки и трек без поля pin (старый формат) не ломают подсчёт', () => {
    const { pin: _pin, ...legacy } = makeTrack({ status: 'ready' });
    expect(albumServerState([undefined, legacy as Track])).toMatchObject({ pin: null, state: 'downloaded' });
    expect(albumServerState([])).toBeNull();
  });

  it('isActiveServerDownload: качается или закреплён и не завершён', () => {
    const s = (state: string, pin: PinState | null) =>
      ({ pin, pinError: null, pinned: pin !== null, state }) as Parameters<typeof isActiveServerDownload>[0];
    expect(isActiveServerDownload(s('downloading', 'downloading'))).toBe(true);
    expect(isActiveServerDownload(s('available', 'queued'))).toBe(true);
    expect(isActiveServerDownload(s('partial', 'waiting_source'))).toBe(true);
    expect(isActiveServerDownload(s('available', 'failed'))).toBe(true);
    expect(isActiveServerDownload(s('downloaded', 'done'))).toBe(false);
    expect(isActiveServerDownload(s('available', null))).toBe(false);
  });
});
