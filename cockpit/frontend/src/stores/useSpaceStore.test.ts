// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSpaces } from './useSpaceStore';

// The space list keeps what the host says about each space.
describe('loadSpaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps whether a space is shared, and only the fields it knows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ spaces: [
      { id: 'main', name: 'Main', main: true, agent: 'atlas', shared: false, taskSystem: true },
      { id: 'eml', name: 'EML', main: false, agent: 'atlas', shared: true },
    ] }))));
    const spaces = await loadSpaces();
    expect(spaces.map((s) => s.shared)).toEqual([false, true]);
    expect(spaces[0]).not.toHaveProperty('taskSystem');
  });
});
