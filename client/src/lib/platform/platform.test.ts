import { afterEach, describe, expect, it } from 'vitest';
import { authHeaders } from './auth-transport';
import { isNative, platform } from './platform';
import { apiBase, apiUrl, setApiBase, wsUrl } from './urls';

afterEach(() => setApiBase(''));

describe('платформа', () => {
  it('в PWA — web, не нативная, без заголовков авторизации', () => {
    expect(platform()).toBe('web');
    expect(isNative()).toBe(false);
    expect(authHeaders()).toEqual({});
  });
});

describe('адреса бэкенда', () => {
  it('пустая база: тот же origin', () => {
    setApiBase('');
    expect(apiBase()).toBe('');
    expect(apiUrl('/api/health')).toBe('/api/health');
    expect(wsUrl('/api/ws')).toBe(`ws://${location.host}/api/ws`);
  });

  it('пустая база на https даёт wss', () => {
    const original = globalThis.location;
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { host: 'a.test', protocol: 'https:' } });
    try {
      expect(wsUrl('/api/ws')).toBe('wss://a.test/api/ws');
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: original });
    }
  });

  it('абсолютная база: хвостовой слэш отбрасывается, схема ws/wss следует за http/https', () => {
    setApiBase('https://music.example.com/');
    expect(apiBase()).toBe('https://music.example.com');
    expect(apiUrl('/api/health')).toBe('https://music.example.com/api/health');
    expect(wsUrl('/api/ws')).toBe('wss://music.example.com/api/ws');
    setApiBase('http://192.168.1.5:8080');
    expect(wsUrl('/api/ws')).toBe('ws://192.168.1.5:8080/api/ws');
  });
});
