import fixture from '../../tests/fixtures/search-radiohead.json';
import type { SearchResponse } from '@/lib/api/search-types';

/** Ответ `GET /api/search?q=radiohead` (фикстура общая с моком бэкенда). */
export const searchFixture = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  ...(structuredClone(fixture) as SearchResponse),
  ...over,
});

export const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
export const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
export const KID_A = '3f0c6c1a-98a1-3d77-a3c8-5b8a2c7d9e22';
export const PARANOID = '8c2a6b1d-1f5e-4a3b-9c7d-2e4f6a8b0c12';
