import { describe, expect, it } from 'vitest';

import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';
import { agentLetter, allSessionState, countsLine, filterByName, groupAllSessions, isRead, sessionMark, type AllSession } from './allSessions';

const main: SpaceInfo = { id: 'main-id', name: 'Main', main: true, label: 'Alpha' };
const other: SpaceInfo = { id: 'other-id', name: 'Other', main: false, label: 'Beta' };
const spaces = [main, other];
const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const FRESH = '2026-02-01T11:00:00.000Z';

const session = (id: string, fields: Partial<AllSession> = {}): AllSession => ({
  id,
  spaceId: main.id,
  state: 'ended',
  createdAt: OLD,
  lastActivity: OLD,
  ...fields,
});
const turn = (state: TurnInfo['state']): TurnInfo => ({ state, since: FRESH });
const attention = (kind: NonNullable<AllSession['attention']>['kind'], at = FRESH) => ({ kind, reason: null, at });
const pinnedField = (s: { isPinned?: boolean }) => Boolean(s.isPinned);
const ids = (list: AllSession[]) => list.map((s) => s.id);
const group = (sessions: AllSession[], turns: Record<string, TurnInfo> = {}, queued: Array<{ id: string; parentSessionId: string }> = []) =>
  groupAllSessions(sessions, spaces, turns, pinnedField, NOW, queued);
const mainIds = (sections: ReturnType<typeof group>) => sections.main.flatMap((g) => g.items.map((item) => item.session.id));

describe('sessionMark', () => {
  it('keeps what a worker reported after its process stopped', () => {
    expect(sessionMark(session('a', { state: 'ended', attention: attention('question') }), undefined)).toBe('question');
    expect(sessionMark(session('a', { state: 'ended', attention: attention('done') }), undefined)).toBe('done');
  });

  it('a new turn takes it away', () => {
    expect(sessionMark(session('a', { state: 'running', attention: attention('review') }), turn('working'))).toBeNull();
  });

  it('a permission card without a report still waits', () => {
    expect(sessionMark(session('a', { state: 'running' }), turn('waiting'))).toBe('waiting');
    expect(sessionMark(session('a', { state: 'ended' }), turn('waiting'))).toBeNull();
  });
});

describe('groupAllSessions', () => {
  it('sorts by what the user has to do, each session once', () => {
    const sections = group([
      session('q', { attention: attention('question'), worker: true }),
      session('f', { attention: attention('failed'), worker: true }),
      session('r', { attention: attention('review'), worker: true }),
      session('d', { attention: attention('done'), worker: true }),
      session('live', { state: 'running' }),
      session('today', { lastActivity: FRESH }),
      session('old'),
    ]);
    expect(ids(sections.needsYou).sort()).toEqual(['f', 'q']);
    expect(ids(sections.toReview).sort()).toEqual(['d', 'r']);
    expect(mainIds(sections).sort()).toEqual(['live', 'today']);
    expect(sections.recent.flatMap((g) => ids(g.sessions))).toEqual(['old']);
  });

  it('opening does not take finished work out of To review, it only reads it', () => {
    const read = session('r', { attention: attention('review'), readAt: '2026-02-01T11:30:00.000Z' });
    expect(isRead(read)).toBe(true);
    expect(ids(group([read]).toReview)).toEqual(['r']);
  });

  it('a newer report is unread again', () => {
    expect(isRead(session('r', { attention: attention('review'), readAt: '2026-02-01T10:00:00.000Z' }))).toBe(false);
  });

  it('puts unread first, then what asks to be checked over what reports done', () => {
    const read = '2026-02-01T11:30:00.000Z';
    const sections = group([
      session('read-review', { attention: attention('review'), readAt: read }),
      session('done', { attention: attention('done') }),
      session('review', { attention: attention('review') }),
    ]);
    expect(ids(sections.toReview)).toEqual(['review', 'done', 'read-review']);
  });

  it('keeps workers under their top session, however deep', () => {
    const sections = group([
      session('p', { lastActivity: FRESH }),
      session('w1', { worker: true, parentSessionId: 'p', state: 'running' }),
      session('w2', { worker: true, parentSessionId: 'w1', state: 'running' }),
    ], { w1: turn('working'), w2: turn('working') });
    expect(mainIds(sections)).toEqual(['p']);
    const [item] = sections.main[0].items;
    expect(ids(item.workers).sort()).toEqual(['w1', 'w2']);
    expect(item.counts.working).toBe(2);
    expect(ids(sections.searchOnly).sort()).toEqual(['w1', 'w2']);
  });

  it('a worker that needs you moves up, and its parent counts it', () => {
    const sections = group([
      session('p', { lastActivity: FRESH }),
      session('w', { worker: true, parentSessionId: 'p', attention: attention('question') }),
    ]);
    expect(ids(sections.needsYou)).toEqual(['w']);
    expect(sections.main[0].items[0].counts.needsYou).toBe(1);
  });

  it('an old parent with a live worker comes back to Main sessions', () => {
    const sections = group([
      session('p'),
      session('w', { worker: true, parentSessionId: 'p', state: 'running' }),
    ], { w: turn('working') });
    expect(mainIds(sections)).toEqual(['p']);
  });

  it('a worker whose parent left the list stands on its own', () => {
    const sections = group([
      session('gone', { archivedAt: FRESH }),
      session('w', { worker: true, parentSessionId: 'gone', state: 'running' }),
      session('ended', { worker: true, parentSessionId: 'unknown' }),
    ], { w: turn('working') });
    expect(mainIds(sections)).toEqual(['w']);
    expect(sections.recent.flatMap((g) => ids(g.sessions))).toEqual(['ended']);
  });

  it('a stopped main session stays for 24 hours', () => {
    expect(mainIds(group([session('a', { lastActivity: '2026-01-31T13:00:00.000Z' })]))).toEqual(['a']);
    expect(mainIds(group([session('a', { lastActivity: '2026-01-31T11:00:00.000Z' })]))).toEqual([]);
  });

  it('pin keeps a session in Main sessions, on top of its agent', () => {
    const sections = group([session('today', { lastActivity: FRESH }), session('pinned', { isPinned: true })]);
    expect(mainIds(sections)).toEqual(['pinned', 'today']);
  });

  it('a pinned session that needs you moves up and comes back', () => {
    const waiting = session('a', { isPinned: true, attention: attention('review') });
    expect(mainIds(group([waiting]))).toEqual([]);
    expect(ids(group([waiting]).toReview)).toEqual(['a']);
    expect(mainIds(group([{ ...waiting, attention: null }]))).toEqual(['a']);
  });

  it('archived sessions only show in search', () => {
    const sections = group([session('a', { archivedAt: FRESH, attention: null })]);
    expect(mainIds(sections)).toEqual([]);
    expect(sections.recent).toEqual([]);
    expect(ids(sections.searchOnly)).toEqual(['a']);
  });

  it('counts what a parent has waiting for memory, and only old idle workers as old', () => {
    const sections = group([
      session('p', { lastActivity: FRESH }),
      session('old', { worker: true }),
      session('recent', { worker: true, lastActivity: FRESH }),
      session('asks', { worker: true, attention: attention('question') }),
      session('pin', { worker: true, isPinned: true }),
    ], {}, [{ id: 'x', parentSessionId: 'p' }, { id: 'y', parentSessionId: 'nobody' }]);
    const parent = sections.main[0].items.find((item) => item.session.id === 'p');
    expect(parent?.counts.queued).toBe(1);
    expect(sections.oldWorkers).toEqual(['old']);
  });

  it('survives a loop of parents', () => {
    const sections = group([
      session('a', { parentSessionId: 'b' }),
      session('b', { parentSessionId: 'a' }),
    ]);
    expect(mainIds(sections).length + sections.recent.flatMap((g) => g.sessions).length + sections.searchOnly.length).toBe(2);
  });

  it('is empty before the spaces load', () => {
    expect(groupAllSessions([session('a')], [], {}, pinnedField, NOW).main).toEqual([]);
  });
});

describe('countsLine', () => {
  it('says it in words, what needs you first', () => {
    const line = countsLine({ working: 3, queued: 1, toReview: 2, needsYou: 1, finished: 0, quietMinutes: 40 });
    expect(line).toBe('1 needs you · 2 to review · 3 working · 1 queued · quiet 40m');
  });

  it('is empty without workers', () => {
    expect(countsLine({ working: 0, queued: 0, toReview: 0, needsYou: 0, finished: 0, quietMinutes: null })).toBe('');
  });
});

describe('allSessionState', () => {
  it('counts an ended session as idle whatever the tracker kept', () => {
    expect(allSessionState(session('a', { state: 'ended' }), turn('waiting'))).toBe('idle');
    expect(allSessionState(session('a', { state: 'running' }), turn('waiting'))).toBe('waiting');
  });
});

describe('filterByName', () => {
  it('finds any case, all when blank', () => {
    const list = [session('a', { summary: 'Login Bug' }), session('b', { summary: 'Other' })];
    expect(ids(filterByName(list, 'login'))).toEqual(['a']);
    expect(ids(filterByName(list, '  '))).toEqual(['a', 'b']);
  });
});

describe('agentLetter', () => {
  it('uses the label', () => {
    expect(agentLetter(other)).toBe('B');
  });
});
