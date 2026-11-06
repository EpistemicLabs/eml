import { describe, expect, it } from 'vitest';

import { attentionKey, joinQueue, pruneQueue, queueAfter, type ReviewState } from './useReviewStore';

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

describe('joinQueue', () => {
  const round = (queue: string[], index: number, seen: Record<string, string> = {}): ReviewState => ({
    queue, index, seen: { ...Object.fromEntries(queue.map((id) => [id, 'k'])), ...seen },
  });

  it('appends what newly waits at the end, in the order given', () => {
    const next = joinQueue(round(['a', 'b'], 1), [{ id: 'a', key: 'k' }, { id: 'x', key: 'k' }, { id: 'b', key: 'k' }, { id: 'y', key: 'k' }]);
    expect(next.queue).toEqual(['a', 'b', 'x', 'y']);
  });

  it('keeps the current session and the order of the queue', () => {
    const next = joinQueue(round(['a', 'b', 'c'], 1), [{ id: 'z', key: 'k' }, { id: 'c', key: 'k' }, { id: 'a', key: 'k' }]);
    expect(next.queue).toEqual(['a', 'b', 'c', 'z']);
    expect(next.queue[next.index]).toBe('b');
  });

  it('never takes a session in twice', () => {
    const next = joinQueue(round(['a'], 0), [{ id: 'x', key: 'k' }, { id: 'x', key: 'k' }]);
    expect(joinQueue(next, [{ id: 'x', key: 'k' }]).queue).toEqual(['a', 'x']);
  });

  it('keeps a session in place when it asks again before its turn', () => {
    const next = joinQueue(round(['a', 'b', 'c'], 0), [{ id: 'b', key: 'new' }]);
    expect(next.queue).toEqual(['a', 'b', 'c']);
    expect(next.seen.b).toBe('new');
  });

  it('keeps a finished session out under the same request, and takes it back once with a new one', () => {
    // b was finished in this round: out of the queue, still seen.
    const finished = round(['a'], 0, { b: 'k' });
    expect(joinQueue(finished, [{ id: 'b', key: 'k' }])).toBe(finished);
    const back = joinQueue(finished, [{ id: 'b', key: 'new' }]);
    expect(back.queue).toEqual(['a', 'b']);
    expect(joinQueue(back, [{ id: 'b', key: 'new' }])).toBe(back);
  });

  it('is the same state when nothing joined', () => {
    const review = round(['a', 'b'], 0);
    expect(joinQueue(review, [{ id: 'b', key: 'k' }, { id: 'a', key: 'k' }])).toBe(review);
  });
});

describe('attentionKey', () => {
  it('changes with a new request and stays the same otherwise', () => {
    const asked = { attention: { at: '2026-11-04T10:00:00Z' }, resultAt: null };
    expect(attentionKey(asked)).toBe(attentionKey({ ...asked }));
    expect(attentionKey(asked)).not.toBe(attentionKey({ attention: { at: '2026-11-04T11:00:00Z' }, resultAt: null }));
  });
});
