import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // Файлы с `@vitest-environment node` (линт-тесты) работают без DOM.
  if (typeof document === 'undefined') return;
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.lang = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof document !== 'undefined') cleanup();
});
