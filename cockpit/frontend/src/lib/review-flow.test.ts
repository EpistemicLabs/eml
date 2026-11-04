import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';

// The review is a screen of its own: it goes through the queue without touching
// the desks, drops what was archived elsewhere, and goes back to the desks at the end.

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const read: string[] = [];
vi.mock('@/lib/session-actions', () => ({
  markSessionRead: (id: string) => { read.push(id); return Promise.resolve(null); },
  clearSession: () => Promise.resolve(null),
  archiveSession: () => Promise.resolve(null),
}));

const session = (id: string, extra: Partial<AllSession> = {}): AllSession => ({ id, spaceId: 'main', __projectId: 'p', ...extra }) as AllSession;
const ARCHIVED = { archivedAt: '2026-11-03T00:00:00Z' };

describe('the review flow', () => {
  let flow: typeof import('./review-flow');
  let review: typeof import('@/stores/useReviewStore');
  let top: typeof import('@/stores/useTopViewStore');
  let panes: typeof import('@/stores/usePaneStore');

  beforeEach(async () => {
    vi.resetModules();
    storage.clear();
    read.length = 0;
    flow = await import('./review-flow');
    review = await import('@/stores/useReviewStore');
    top = await import('@/stores/useTopViewStore');
    panes = await import('@/stores/usePaneStore');
    panes.openInPane({ surface: 'terminal', projectId: 'p', sessionId: 'mine' });
  });

  const layout = () => JSON.stringify(panes.getDesks().map((desk) => desk.panes.map((pane) => pane.sessionId)));

  it('opens its own screen in the order given and leaves the desks as they are', () => {
    const before = layout();
    const sessions = [session('q'), session('a'), session('mine')];
    flow.startReview(sessions);
    expect(top.getTopView()).toBe('review');
    for (let step = 0; step < 2; step += 1) flow.stepReview(1, sessions);
    expect(review.getReview()).toMatchObject({ queue: ['q', 'a', 'mine'], index: 2 });
    expect(read).toEqual(['q', 'a', 'mine']);
    expect(layout()).toBe(before);
  });

  it('goes back to the desks at the end', () => {
    flow.startReview([session('a')]);
    flow.endReview();
    expect(top.getTopView()).toBe('desks');
    expect(review.getReview()).toBeNull();
  });

  it('is never restored after a reload', async () => {
    flow.startReview([session('a')]);
    vi.resetModules();
    top = await import('@/stores/useTopViewStore');
    expect(top.getTopView()).toBe('desks');
  });

  it('skips a session archived elsewhere instead of stopping', () => {
    flow.startReview([session('a'), session('b'), session('c')]);
    flow.stepReview(1, [session('a'), session('b', ARCHIVED), session('c')]);
    expect(review.getReview()).toMatchObject({ queue: ['a', 'c'], index: 1 });
  });

  it('goes on after Archive & next past a session archived elsewhere, and ends after the last', async () => {
    flow.startReview([session('a'), session('b'), session('c')]);
    await flow.finishCurrent('archive', [session('a'), session('b', ARCHIVED), session('c')]);
    expect(review.getReview()).toMatchObject({ queue: ['c'], index: 0 });
    await flow.finishCurrent('clear', [session('c')]);
    expect(review.getReview()).toBeNull();
    expect(top.getTopView()).toBe('desks');
  });

  const asked = (id: string, at: string) => session(id, { attention: { kind: 'question', reason: null, at } });

  it('takes in what newly waits at the end while the current one stays', () => {
    flow.startReview([asked('a', 't1'), asked('b', 't1')]);
    flow.stepReview(1, [asked('a', 't1'), asked('b', 't1')]);
    flow.joinReview([asked('n', 't2'), asked('a', 't1'), asked('b', 't1')]);
    expect(review.getReview()).toMatchObject({ queue: ['a', 'b', 'n'], index: 1 });
    expect(read).toEqual(['a', 'b']);
  });

  it('does nothing without an open review', () => {
    flow.joinReview([asked('n', 't1')]);
    expect(review.getReview()).toBeNull();
  });

  it('goes on after the last to what arrived, and ends only when nothing is left', async () => {
    flow.startReview([asked('a', 't1')]);
    flow.joinReview([asked('a', 't1'), asked('n', 't2')]);
    await flow.finishCurrent('archive', [asked('a', 't1'), asked('n', 't2')]);
    expect(review.getReview()).toMatchObject({ queue: ['n'], index: 0 });
    await flow.finishCurrent('archive', [asked('n', 't2')]);
    expect(review.getReview()).toBeNull();
    expect(top.getTopView()).toBe('desks');
  });

  it('keeps a finished session out until it asks again', async () => {
    flow.startReview([asked('a', 't1'), asked('b', 't1')]);
    await flow.finishCurrent('clear', [asked('a', 't1'), asked('b', 't1')]);
    // The list still shows a until its refresh: the same request does not bring it back.
    flow.joinReview([asked('a', 't1'), asked('b', 't1')]);
    expect(review.getReview()).toMatchObject({ queue: ['b'], index: 0 });
    flow.joinReview([asked('b', 't1'), asked('a', 't3')]);
    flow.joinReview([asked('b', 't1'), asked('a', 't3')]);
    expect(review.getReview()).toMatchObject({ queue: ['b', 'a'], index: 0 });
  });
});
