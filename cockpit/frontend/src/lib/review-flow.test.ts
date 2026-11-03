import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { SpaceInfo } from '@/stores/useSpaceStore';

// The review flow goes through sessions in one pane. Pressing D must not open
// panes or move the layout: the flow's pane swaps its session in place.

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const released: Array<[string, string]> = [];
vi.mock('@/utils/api', () => ({
  api: { releaseSession: (sessionId: string, paneId: string) => { released.push([sessionId, paneId]); return Promise.resolve(); } },
}));
vi.mock('@/lib/session-actions', () => ({
  markSessionRead: () => Promise.resolve(null),
  answerSession: () => Promise.resolve(null),
  clearSession: () => Promise.resolve(null),
  archiveSession: () => Promise.resolve(null),
}));

const MAIN: SpaceInfo = { id: 'main', name: 'Main', main: true };
const OTHER: SpaceInfo = { id: 'other', name: 'Other', main: false };
const SPACES = [MAIN, OTHER];

const session = (id: string, spaceId = 'main', extra: Partial<AllSession> = {}): AllSession =>
  ({ id, spaceId, __projectId: 'p', ...extra }) as AllSession;

describe('the review flow', () => {
  let store: typeof import('@/stores/usePaneStore');
  let flow: typeof import('./review-flow');
  let review: typeof import('@/stores/useReviewStore');

  beforeEach(async () => {
    vi.resetModules();
    storage.clear();
    released.length = 0;
    store = await import('@/stores/usePaneStore');
    flow = await import('./review-flow');
    review = await import('@/stores/useReviewStore');
    store.setEmptyPaneTest((pane) => !pane.projectId);
    // A desk with work on it: the review opens next to it.
    store.openInPane({ surface: 'terminal', projectId: 'p', sessionId: 'mine' });
  });

  const paneCount = () => store.getDesks().reduce((count, desk) => count + desk.panes.length, 0);

  it('goes through five sessions in one pane, swapped in place', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => session(id));
    flow.startReview(sessions, SPACES);
    const paneId = review.getReview()?.paneId;
    const panes = paneCount();
    for (let step = 0; step < 5; step += 1) flow.stepReview(1, sessions, SPACES);
    expect(review.getReview()?.paneId).toBe(paneId);
    expect(store.getPane(paneId!)?.sessionId).toBe('f');
    expect(paneCount()).toBe(panes);
    expect(released.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('closes its pane at the end and leaves the user\'s', () => {
    const sessions = [session('a'), session('b')];
    flow.startReview(sessions, SPACES);
    flow.endReview();
    expect(paneCount()).toBe(1);
    expect(store.paneHoldingSession('mine')).toBeDefined();
  });

  it('goes to a pane of the user\'s on this desk and leaves it open', () => {
    const sessions = [session('a'), session('mine'), session('c')];
    flow.startReview(sessions, SPACES);
    flow.stepReview(1, sessions, SPACES);
    const mine = store.paneHoldingSession('mine');
    expect(review.getReview()).toMatchObject({ paneId: mine?.id, ownsPane: false });
    expect(paneCount()).toBe(1);
    flow.endReview();
    expect(store.paneHoldingSession('mine')).toBeDefined();
  });

  it('keeps swapping in a review pane the user made the main pane', () => {
    const sessions = [session('a'), session('b'), session('c')];
    flow.startReview(sessions, SPACES);
    const paneId = review.getReview()!.paneId!;
    store.toggleMainPane(paneId);
    flow.stepReview(1, sessions, SPACES);
    flow.stepReview(1, sessions, SPACES);
    expect(review.getReview()?.paneId).toBe(paneId);
    expect(paneCount()).toBe(2);
  });

  it('takes the open space first and changes the desk once for another space', () => {
    const sessions = [session('x', 'other'), session('a'), session('y', 'other'), session('b')];
    flow.startReview(sessions, SPACES);
    expect(review.getReview()?.queue).toEqual(['a', 'b', 'x', 'y']);
    flow.stepReview(1, sessions, SPACES);
    expect(store.getActiveSpaceId()).toBeNull();
    flow.stepReview(1, sessions, SPACES);
    const inOther = review.getReview()!.paneId!;
    expect(store.getDeskOfPane(inOther)?.spaceId).toBe('other');
    flow.stepReview(1, sessions, SPACES);
    expect(review.getReview()?.paneId).toBe(inOther);
    expect(store.getPane(inOther)?.sessionId).toBe('y');
  });

  it('skips a session archived elsewhere instead of stopping', () => {
    const sessions = [session('a'), session('b'), session('c')];
    flow.startReview(sessions, SPACES);
    const later = [session('a'), session('b', 'main', { archivedAt: '2026-11-03T00:00:00Z' }), session('c')];
    flow.stepReview(1, later, SPACES);
    expect(review.getReview()).toMatchObject({ queue: ['a', 'c'], index: 1 });
  });

  it('goes on after Archive & next past a session archived elsewhere', async () => {
    const sessions = [session('a'), session('b'), session('c')];
    flow.startReview(sessions, SPACES);
    const later = [session('a'), session('b', 'main', { archivedAt: '2026-11-03T00:00:00Z' }), session('c')];
    await flow.finishCurrent('archive', later, SPACES);
    expect(review.getReview()).toMatchObject({ queue: ['c'], index: 0 });
  });
});
