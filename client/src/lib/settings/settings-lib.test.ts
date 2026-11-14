import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { getAt, hasAt, isPresent, leafPaths, mergePatch, patchAt } from './paths';

describe('paths', () => {
  const settings = { a: { b: 1, c: null, d: { e: 'x' } }, list: [1, 2] };

  it('getAt/hasAt: значение по пути, отсутствие звена — undefined', () => {
    expect(getAt(settings, 'a.b')).toBe(1);
    expect(getAt(settings, 'a.d.e')).toBe('x');
    expect(getAt(settings, 'a.zz')).toBeUndefined();
    expect(getAt(settings, 'list.0')).toBeUndefined();
    expect(getAt(null, 'a')).toBeUndefined();
    expect(hasAt(settings, 'a.c')).toBe(true);
    expect(hasAt(settings, 'a.nope')).toBe(false);
  });

  it('isPresent: поле есть, либо родитель — null (необязательный объект)', () => {
    expect(isPresent(settings, 'a.b')).toBe(true);
    expect(isPresent(settings, 'a.c.url')).toBe(true);
    expect(isPresent(settings, 'a.zz')).toBe(false);
    expect(isPresent(settings, 'top')).toBe(false);
  });

  it('patchAt строит вложенный патч', () => {
    expect(patchAt('a.b.c', 5)).toEqual({ a: { b: { c: 5 } } });
    expect(patchAt('x', null)).toEqual({ x: null });
  });

  it('mergePatch сливает объекты, заменяет массивы и скаляры, null сбрасывает; исходник не меняется', () => {
    const merged = mergePatch(settings, { a: { b: 2, c: { url: 'u' }, d: { f: 1 } }, list: [3] });
    expect(merged).toEqual({ a: { b: 2, c: { url: 'u' }, d: { e: 'x', f: 1 } }, list: [3] });
    expect(settings.a.b).toBe(1);
    expect(mergePatch(settings, { a: { b: null } }).a.b).toBeNull();
    expect(mergePatch(null, { z: 1 })).toEqual({ z: 1 });
  });

  it('leafPaths перечисляет листья патча', () => {
    expect(leafPaths({ a: { b: 1, c: { d: 2 } }, e: [1], f: {} })).toEqual(['a.b', 'a.c.d', 'e', 'f']);
  });
});

describe('ApiError.field', () => {
  it('хранит путь поля, по умолчанию его нет', () => {
    expect(new ApiError(400, 'invalid_settings', 'bad', 'musicbrainz.burst').field).toBe('musicbrainz.burst');
    expect(new ApiError(500, 'internal', 'x').field).toBeUndefined();
  });
});
