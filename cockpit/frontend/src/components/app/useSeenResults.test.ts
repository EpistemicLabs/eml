import { describe, expect, it, vi } from 'vitest';

const pane = vi.hoisted(() => ({ active: undefined as { paneView: string; sessionId: string | null } | undefined }));
vi.mock('@/stores/usePaneStore', () => ({ getActivePane: () => pane.active }));
vi.mock('@/stores/useTopViewStore', () => ({ getTopView: () => 'desks' }));
vi.mock('@/lib/session-actions', () => ({ SESSIONS_CHANGED_EVENT: 'x', markSessionRead: () => Promise.resolve(null) }));

import type { AllSession } from '@/components/sidebar/allSessions';
import { sessionsInFront, sessionsToMarkSeen } from './useSeenResults';

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

describe('sessionsInFront', () => {
  it('is the active pane\'s session, so a result in the pane beside it stays unseen', () => {
    pane.active = { paneView: 'terminal', sessionId: 'a' };
    expect([...sessionsInFront()]).toEqual(['a']);
  });

  it('is nothing while the active pane shows no session', () => {
    pane.active = { paneView: 'files', sessionId: 'a' };
    expect(sessionsInFront().size).toBe(0);
    pane.active = undefined;
    expect(sessionsInFront().size).toBe(0);
  });
});
