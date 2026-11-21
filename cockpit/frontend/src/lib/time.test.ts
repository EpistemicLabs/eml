// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { DAY_MS, durationMs } from './time';

afterEach(() => document.documentElement.removeAttribute('style'));

describe('durationMs', () => {
  it('reads a --duration-* token in milliseconds, in ms or s', () => {
    document.documentElement.style.setProperty('--duration-toast', '3200ms');
    document.documentElement.style.setProperty('--duration-base', '.3s');
    expect(durationMs('--duration-toast')).toBe(3200);
    expect(durationMs('--duration-base')).toBe(300);
  });

  it('is 0 where the token is not set, so nothing waits on a missing stylesheet', () => {
    expect(durationMs('--duration-missing')).toBe(0);
  });
});

describe('DAY_MS', () => {
  it('is one day', () => {
    expect(new Date(2026, 0, 1).getTime() + DAY_MS).toBe(new Date(2026, 0, 2).getTime());
  });
});
