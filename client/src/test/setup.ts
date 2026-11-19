import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { recordRequest } from './network';

// Сеть в тестах недоступна. Клиент API захватывает `fetch` при создании (при импорте), поэтому подмена — здесь, до
// импорта тестируемых модулей. Тесты, которым нужны ответы, создают клиент со своим `fetch` или мокают модуль API.
// Каждый вызов записывается в `networkLog` (`src/test/network.ts`): по нему «сторож» проверяет, что экран не ходит в сеть.
if (typeof document !== 'undefined') {
  globalThis.fetch = (input, init) => {
    recordRequest(input, init);
    return Promise.reject(new TypeError('network is disabled in tests'));
  };
}

beforeEach(() => {
  // Файлы с `@vitest-environment node` (линт-тесты) работают без DOM.
  if (typeof document === 'undefined') return;
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.className = '';
  document.documentElement.lang = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof document !== 'undefined') cleanup();
});
