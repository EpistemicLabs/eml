// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSpaces } from './useSpaceStore';

// The space list keeps what the host says about each space, the task system among it.
describe('loadSpaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the task system switch of a space, and leaves it out where it is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ spaces: [
      { id: 'main', name: 'Main', main: true, agent: 'atlas', shared: false, taskSystem: true },
      { id: 'eml', name: 'EML', main: false, agent: 'atlas', shared: true, taskSystem: false },
    ] }))));
    const spaces = await loadSpaces();
    expect(spaces.map((s) => s.taskSystem)).toEqual([true, undefined]);
  });
});
