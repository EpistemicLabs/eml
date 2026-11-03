import { describe, expect, it } from 'vitest';

import { pruneQueue, queueAfter } from './useReviewStore';

describe('queueAfter', () => {
  it('goes on to the next one', () => {
    expect(queueAfter(['a', 'b', 'c'], 1)).toEqual({ queue: ['a', 'c'], index: 1 });
  });

  it('falls back to the one before at the end', () => {
    expect(queueAfter(['a', 'b'], 1)).toEqual({ queue: ['a'], index: 0 });
  });

  it('has nowhere to go after the last', () => {
    expect(queueAfter(['a'], 0)).toEqual({ queue: [], index: -1 });
  });
});

describe('pruneQueue', () => {
  it('drops what left the lists and keeps its place', () => {
    expect(pruneQueue(['a', 'b', 'c', 'd'], 2, new Set(['a', 'c', 'd']))).toEqual({ queue: ['a', 'c', 'd'], index: 1 });
  });

  it('keeps the current one until the flow moves on', () => {
    expect(pruneQueue(['a', 'b', 'c'], 1, new Set(['a', 'c']))).toEqual({ queue: ['a', 'b', 'c'], index: 1 });
  });

  it('has no current one in an empty queue', () => {
    expect(pruneQueue([], 0, new Set())).toEqual({ queue: [], index: -1 });
  });
});
