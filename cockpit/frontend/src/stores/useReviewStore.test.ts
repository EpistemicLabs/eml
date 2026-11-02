import { describe, expect, it } from 'vitest';

import { queueAfter } from './useReviewStore';

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
