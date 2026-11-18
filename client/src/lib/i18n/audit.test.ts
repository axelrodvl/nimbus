// Полнота словарей (шаг 49): нет неиспользуемых ключей, нет непереведённых значений, нет «зашитых» строк вне словарей.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './config';
import { enMessages, loadMessages, type MessageKey } from './messages';

const SRC = join(__dirname, '..', '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const sources = [...walk(SRC)].filter(
  f => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('/i18n/messages/'),
);
const code = sources.map(f => readFileSync(f, 'utf8')).join('\n');

/**
 * Значения, которые в неанглийских словарях законно совпадают с английским: названия, единицы и слова-заимствования
 * или общие корни (fr «Sources», de «Downloads», es «Error»). Сверено вручную по каждому языку (шаг 49).
 */
const SAME_AS_ENGLISH = new Set(
  [
    'Nimbus',
    'MusicBrainz',
    'Opus',
    'MP3',
    'Cookie (bb_session=…)',
    'Torrents',
    'Error',
    'error',
    'No',
    'Proxy',
    'User-Agent',
    'Pause',
    'Sources',
    'Format',
    'Source',
    'Album',
    'Albums',
    'Single',
    'Singles',
    'EPs',
    'EP',
    'Playlist',
    'Playlists',
    'Actions',
    'Volume',
    'Type',
    'Score',
    'Details',
    'Offline',
    'Online',
    'Downloads',
    'Seeding',
    'System',
    'Burst',
    'Home',
    'Password',
    'Pause: {title}',
    'Peers: {peers} · Seeds: {seeds}',
    'Seeders / leechers',
    'Torrents: {count} · ↓ {down} · ↑ {up}',
    '{"one":"{count} album","other":"{count} albums"}',
    '{"one":"{count} peer","other":"{count} peers"}',
  ].map(v => v.trim()),
);
/** Единицы измерения (`KB/s`, `{count} min`, `s`) одинаковы во всех языках. */
const UNITS = /^(\{\w+\} )?(B|KB|MB|GB|TB|h|min|s|\/s)(\/s)?$/;

describe('словари: полнота', () => {
  it('нет неиспользуемых ключей', () => {
    const unused = Object.keys(enMessages).filter(key => {
      if (code.includes(`'${key}'`) || code.includes(`"${key}"`) || code.includes(`\`${key}\``)) return false;
      // Динамические ключи: `prefix.${x}` — достаточно, чтобы префикс встречался в шаблоне.
      const dot = key.lastIndexOf('.');
      return !(dot > 0 && code.includes(`${key.slice(0, dot + 1)}\${`));
    });
    expect(unused).toEqual([]);
  });

  it('значения неанглийских словарей не совпадают с английскими (кроме названий)', async () => {
    const offenders: string[] = [];
    for (const { code: locale } of LOCALES) {
      if (locale === 'en') continue;
      const messages = await loadMessages(locale);
      for (const [key, value] of Object.entries(enMessages)) {
        if (JSON.stringify(messages[key as MessageKey]) !== JSON.stringify(value)) continue;
        const text = (typeof value === 'string' ? value : JSON.stringify(value)).trim();
        if (SAME_AS_ENGLISH.has(text) || UNITS.test(text)) continue;
        offenders.push(`${locale}:${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('в коде вне словарей нет зашитой кириллицы', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Законная кириллица: названия языков, нормализация «ё» → «е» для поиска, тестовые данные.
    const allowed = ['lib/i18n/config.ts', 'lib/store/selectors.ts', 'test/factories.ts'];
    const offenders = sources.filter(
      f => !allowed.some(a => f.endsWith(a)) && /[А-Яа-яЁё]/.test(strip(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map(f => f.replace(SRC, 'src'))).toEqual([]);
  });
});
