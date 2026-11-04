import { describe, expect, it } from 'vitest';

import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';
import { allSessionState, countsLine, filterByName, groupAllSessions, isRead, isUnseen, sessionMark, type AllSession } from './allSessions';

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
    expect(sessionMark(session('a', { state: 'ended', attention: attention('review') }), undefined)).toBe('review');
  });

  it('a new turn takes it away', () => {
    expect(sessionMark(session('a', { state: 'running', attention: attention('review') }), turn('working'))).toBeNull();
  });

  it('a permission card without a report still waits', () => {
    expect(sessionMark(session('a', { state: 'running' }), turn('waiting'))).toBe('waiting');
    expect(sessionMark(session('a', { state: 'ended' }), turn('waiting'))).toBeNull();
  });
});

describe('the one model for every session', () => {
  const seen = '2026-02-01T11:30:00.000Z';

  it('a result without a request leaves once seen, whoever started the session', () => {
    expect(sessionMark(session('a', { resultAt: FRESH }), undefined)).toBe('result');
    expect(sessionMark(session('a', { resultAt: null, readAt: seen }), undefined)).toBeNull();
    expect(sessionMark(session('w', { worker: true, attention: attention('done') }), undefined)).toBe('result');
    expect(sessionMark(session('w', { worker: true, attention: attention('done'), readAt: seen }), undefined)).toBeNull();
  });

  it('a check stays after it is read, until it is dealt with', () => {
    const read = session('r', { attention: attention('review'), resultAt: null, readAt: seen });
    expect(sessionMark(read, undefined)).toBe('review');
    expect(isRead(read)).toBe(true);
  });

  it('a question or failure stays after it is read', () => {
    expect(sessionMark(session('q', { attention: attention('question'), readAt: seen }), undefined)).toBe('question');
    expect(sessionMark(session('f', { attention: attention('failed'), readAt: seen }), undefined)).toBe('failed');
  });

  it('what a session asks outranks its result', () => {
    expect(sessionMark(session('a', { state: 'running', resultAt: FRESH }), turn('waiting'))).toBe('waiting');
    expect(sessionMark(session('a', { attention: attention('question'), resultAt: FRESH }), undefined)).toBe('question');
    expect(sessionMark(session('a', { attention: attention('review'), resultAt: FRESH }), undefined)).toBe('review');
  });

  it('a new turn hides the mark', () => {
    expect(sessionMark(session('a', { state: 'running', resultAt: FRESH }), turn('working'))).toBeNull();
  });

  it('only what seeing would change counts as unseen', () => {
    expect(isUnseen(session('a', { resultAt: FRESH }))).toBe(true);
    expect(isUnseen(session('a', { attention: attention('review') }))).toBe(true);
    expect(isUnseen(session('a', { attention: attention('review'), readAt: seen }))).toBe(false);
    expect(isUnseen(session('a'))).toBe(false);
  });
});

describe('groupAllSessions', () => {
  it('sorts by what the user has to do, each session once', () => {
    const sections = group([
      session('q', { attention: attention('question'), worker: true }),
      session('f', { attention: attention('failed'), worker: true }),
      session('r', { attention: attention('review'), worker: true }),
      session('d', { attention: attention('done'), worker: true }),
      session('pin', { isPinned: true }),
      session('desk', { deskMain: true }),
      session('busy', { state: 'running' }),
      session('open', { state: 'running' }),
      session('today', { lastActivity: FRESH }),
      session('old'),
    ], { busy: turn('working') });
    expect(ids(sections.needsYou).sort()).toEqual(['f', 'q']);
    expect(ids(sections.toReview).sort()).toEqual(['d', 'r']);
    expect(mainIds(sections).sort()).toEqual(['desk', 'pin']);
    expect(sections.working.map((item) => item.session.id)).toEqual(['busy']);
    expect(sections.recent.flatMap((g) => ids(g.sessions)).sort()).toEqual(['old', 'open', 'today']);
  });

  it('lists a main session that works under Working too', () => {
    const sections = group([session('pin', { isPinned: true, state: 'running' })], { pin: turn('working') });
    expect(mainIds(sections)).toEqual(['pin']);
    expect(sections.working.map((item) => item.session.id)).toEqual(['pin']);
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

  it('lists each working worker on its own row, however deep, its parent by its own state', () => {
    const sections = group([
      session('p', { lastActivity: FRESH }),
      session('w1', { worker: true, parentSessionId: 'p', state: 'running' }),
      session('w2', { worker: true, parentSessionId: 'w1', state: 'running' }),
    ], { w1: turn('working'), w2: turn('working') });
    expect(mainIds(sections)).toEqual([]);
    expect(sections.working.map((item) => item.session.id).sort()).toEqual(['w1', 'w2']);
    expect(sections.recent.flatMap((g) => ids(g.sessions))).toEqual(['p']);
    expect(sections.items.get('p')?.counts.working).toBe(2);
    expect(sections.searchOnly).toEqual([]);
  });

  it('a main session stays main while its workers work in their own rows', () => {
    const sections = group([
      session('p', { deskMain: true }),
      session('w', { worker: true, parentSessionId: 'p', state: 'running' }),
    ], { w: turn('working') });
    expect(mainIds(sections)).toEqual(['p']);
    expect(sections.working.map((item) => item.session.id)).toEqual(['w']);
  });

  it('a worker chosen as main stands on its own, with the workers below it', () => {
    const sections = group([
      session('p'),
      session('w', { worker: true, parentSessionId: 'p', isPinned: true }),
      session('below', { worker: true, parentSessionId: 'w' }),
    ]);
    expect(mainIds(sections)).toEqual(['w']);
    expect(ids(sections.items.get('w')?.workers ?? [])).toEqual(['below']);
    expect(sections.items.get('p')?.workers).toEqual([]);
  });

  it('a worker that needs you moves up, and its parent counts it from wherever it is', () => {
    const sections = group([
      session('p'),
      session('w', { worker: true, parentSessionId: 'p', attention: attention('question') }),
    ]);
    expect(ids(sections.needsYou)).toEqual(['w']);
    expect(sections.recent.flatMap((g) => ids(g.sessions))).toEqual(['p']);
    expect(sections.items.get('p')?.counts.needsYou).toBe(1);
  });

  it('a quiet parent and its finished worker both sit in Recent', () => {
    const sections = group([session('p'), session('w', { worker: true, parentSessionId: 'p' })]);
    expect(sections.recent.flatMap((g) => ids(g.sessions)).sort()).toEqual(['p', 'w']);
  });

  it('a worker whose parent left the list stands on its own', () => {
    const sections = group([
      session('gone', { archivedAt: FRESH }),
      session('w', { worker: true, parentSessionId: 'gone', state: 'running' }),
      session('ended', { worker: true, parentSessionId: 'unknown' }),
    ], { w: turn('working') });
    expect(sections.working.map((item) => item.session.id)).toEqual(['w']);
    expect(sections.recent.flatMap((g) => ids(g.sessions)).sort()).toEqual(['ended', 'gone']);
  });

  it('being used today or left open does not make a session main', () => {
    expect(mainIds(group([session('a', { lastActivity: FRESH, state: 'running' })]))).toEqual([]);
  });

  it('pin and desk both make a session main, pinned on top of its agent', () => {
    const sections = group([session('desk', { deskMain: true }), session('pinned', { isPinned: true })]);
    expect(mainIds(sections)).toEqual(['pinned', 'desk']);
  });

  it('a pinned session that needs you moves up and comes back', () => {
    const waiting = session('a', { isPinned: true, attention: attention('review') });
    expect(mainIds(group([waiting]))).toEqual([]);
    expect(ids(group([waiting]).toReview)).toEqual(['a']);
    expect(mainIds(group([{ ...waiting, attention: null }]))).toEqual(['a']);
  });

  it('archived sessions go to Recent like any older chat, workers too', () => {
    const sections = group([
      session('chat', { archivedAt: FRESH, lastActivity: FRESH, attention: null }),
      session('worker', { archivedAt: FRESH, worker: true, parentSessionId: 'chat', attention: null }),
    ]);
    expect(mainIds(sections)).toEqual([]);
    expect(sections.recent.flatMap((g) => ids(g.sessions))).toEqual(['chat', 'worker']);
    expect(sections.searchOnly).toEqual([]);
  });

  it('counts what a parent has waiting for memory', () => {
    const sections = group([session('p')], {}, [{ id: 'x', parentSessionId: 'p' }, { id: 'y', parentSessionId: 'nobody' }]);
    expect(sections.working[0].counts.queued).toBe(1);
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

