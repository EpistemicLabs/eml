import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/usePaneStore', () => ({}));
vi.mock('@/stores/useTopViewStore', () => ({ getTopView: () => 'desks' }));
vi.mock('@/lib/session-actions', () => ({ SESSIONS_CHANGED_EVENT: 'x', markSessionRead: () => Promise.resolve(null) }));
vi.mock('@/utils/api', () => ({ api: {} }));
vi.mock('@/lib/push', () => ({ pushEndpoint: () => Promise.resolve(null) }));

import type { AllSession } from '@/components/sidebar/allSessions';
import { cockpitInUse, sessionsToMarkSeen, sessionsWatched } from './useSeenResults';

const NOW = 1_000_000;
const unseen: AllSession = { id: 'a', spaceId: 's', resultAt: '2026-01-01T00:00:00.000Z' };
const here = { foreground: true, lastInputAt: NOW - 1_000, now: NOW };

describe('sessionsToMarkSeen', () => {
  it('counts what is on screen with someone there', () => {
    expect(sessionsToMarkSeen([unseen], new Set(['a']), here)).toEqual(['a']);
  });

  it.each([
    ['the pane is not on screen', new Set<string>(), here],
    ['the tab is behind', new Set(['a']), { ...here, foreground: false }],
    ['nobody has moved for a minute', new Set(['a']), { ...here, lastInputAt: NOW - 60_000 }],
    ['nobody has moved since the page opened', new Set(['a']), { ...here, lastInputAt: 0 }],
  ])('leaves it unseen when %s', (_why, onScreen, facts) => {
    expect(sessionsToMarkSeen([unseen], onScreen, facts)).toEqual([]);
  });

  it('asks nothing of a session with nothing to see', () => {
    expect(sessionsToMarkSeen([{ id: 'a', spaceId: 's' }], new Set(['a']), here)).toEqual([]);
  });
});

describe('sessionsWatched', () => {
  it('names every session on screen while someone is there, seen or not: no push about them', () => {
    expect(sessionsWatched(new Set(['a', 'b']), here)).toEqual(['a', 'b']);
    expect(sessionsWatched(new Set(['a']), { ...here, foreground: false })).toEqual([]);
    expect(sessionsWatched(new Set(['a']), { ...here, lastInputAt: NOW - 60_000 })).toEqual([]);
  });
});

describe('cockpitInUse', () => {
  it('counts the cockpit in use for ten minutes after the last click or key, in front or not', () => {
    const behind = { ...here, foreground: false, lastInputAt: NOW - 9 * 60_000 };
    expect(cockpitInUse(behind)).toBe(true);
    expect(cockpitInUse({ ...here, lastInputAt: NOW - 10 * 60_000 })).toBe(false);
    expect(cockpitInUse({ ...here, lastInputAt: 0 })).toBe(false);
  });
});
