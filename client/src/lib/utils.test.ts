import { describe, expect, it } from 'vitest';
import { cn, formatCount, formatDuration } from './utils';

describe('utils', () => {
  it('cn склеивает и разруливает конфликты tailwind', () => {
    expect(cn('p-2', false, 'p-4', ['text-sm'])).toBe('p-4 text-sm');
  });
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
  });
  it('formatCount', () => {
    expect([999, 1500, 25_000, 2_500_000].map(formatCount)).toEqual(['999', '1.5K', '25K', '2.5M']);
  });
});
