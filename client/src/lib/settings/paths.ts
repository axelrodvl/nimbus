import type { Patch } from './types';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Значение по пути через точку (`musicbrainz.burst`); `undefined`, если какого-то звена нет. */
export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (!isObject(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Есть ли поле в ответе сервера: условный показ строк настроек. */
export const hasAt = (obj: unknown, path: string): boolean => getAt(obj, path) !== undefined;

/** Патч из одного значения: `patchAt('a.b', 1)` → `{ a: { b: 1 } }`. */
export function patchAt(path: string, value: unknown): Patch {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>((acc, key) => ({ [key]: acc }), value) as Patch;
}

/** Слияние патча в настройки (как на сервере): объекты сливаются, остальное заменяется; `null` сбрасывает поле. */
export function mergePatch<T>(base: T, patch: Patch): T {
  const out: Json = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? mergePatch(out[key], value) : value;
  }
  return out as T;
}

/** Пути всех листьев патча (`{a:{b:1}}` → `['a.b']`): по ним ошибка сервера привязывается к полю. */
export function leafPaths(patch: Patch, prefix = ''): string[] {
  return Object.entries(patch).flatMap(([key, value]) =>
    isObject(value) && Object.keys(value).length > 0 ? leafPaths(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

/**
 * Показывать ли поле: оно есть в ответе сервера, либо его родитель — `null` (необязательный объект, например
 * `providers.rutracker`, который создаётся первым заполненным полем).
 */
export function isPresent(obj: unknown, path: string): boolean {
  if (getAt(obj, path) !== undefined) return true;
  const parent = path.split('.').slice(0, -1).join('.');
  return parent !== '' && getAt(obj, parent) === null;
}
