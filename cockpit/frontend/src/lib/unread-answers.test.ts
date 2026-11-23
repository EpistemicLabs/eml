import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { TurnInfo } from '@/stores/useTurnStateStore';

import type { InboxItem } from './task-board';
import { answerLine, readBefore, unreadAnswers, unreadFoldOpen } from './unread-answers';

const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const EARLY = '2026-02-01T09:00:00.000Z';
const LATE = '2026-02-01T11:00:00.000Z';
const READ = '2026-02-01T11:30:00.000Z';

const session = (id: string, fields: Partial<AllSession> = {}): AllSession => ({
  id, spaceId: 'space', state: 'ended', createdAt: EARLY, lastActivity: EARLY,
  attention: { kind: 'done', reason: `Answer of ${id}`, at: LATE },
  ...fields,
});
const item = (fields: Partial<InboxItem>): InboxItem => ({ key: 'k', kind: 'question', space: 'space', title: 't', text: '', since: LATE, ...fields });
const empty = { inbox: [] as InboxItem[], snoozed: [] as InboxItem[] };
const ids = (list: AllSession[]) => list.map((s) => s.id);
const pick = (sessions: AllSession[], board = empty, turns: Record<string, TurnInfo> = {}) => ids(unreadAnswers(sessions, board, turns, NOW));

describe('unreadAnswers', () => {
  it('lists a session whose answer nobody opened, and drops it once read', () => {
    expect(pick([session('a')])).toEqual(['a']);
    expect(pick([session('a', { readAt: READ })])).toEqual([]);
  });

  it('lists a finished turn that left no report until it is seen', () => {
    expect(pick([session('a', { attention: null, resultAt: LATE })])).toEqual(['a']);
    expect(pick([session('a', { attention: null, resultAt: null, readAt: READ })])).toEqual([]);
  });

  it('a new answer after the last read brings it back', () => {
    expect(pick([session('a', { readAt: EARLY })])).toEqual(['a']);
  });

  it('leaves out what is not an answer: questions, reviews, failures, a session at work', () => {
    expect(pick([
      session('q', { attention: { kind: 'question', reason: null, at: LATE } }),
      session('r', { attention: { kind: 'review', reason: null, at: LATE } }),
      session('f', { attention: { kind: 'failed', reason: null, at: LATE } }),
      session('w', { state: 'running' }),
    ], empty, { w: { state: 'working', since: LATE } })).toEqual([]);
  });

  it('leaves out archived, snoozed and worker sessions', () => {
    expect(pick([
      session('archived', { archivedAt: LATE }),
      session('snoozed', { snoozedUntil: '2026-02-02T09:00:00.000Z' }),
      session('worker', { worker: true, parentSessionId: 'p' }),
    ])).toEqual([]);
  });

  it('a snooze that has run out no longer hides it', () => {
    expect(pick([session('a', { snoozedUntil: EARLY })])).toEqual(['a']);
  });

  it('keeps a session the user split off another one: it is theirs, not a worker', () => {
    expect(pick([session('split', { parentSessionId: 'p' })])).toEqual(['split']);
  });

  it('leaves out a session the Inbox already lists, by its own item or its task', () => {
    const board = { inbox: [item({ sessionId: 'own' }), item({ taskId: 'task-1' })], snoozed: [item({ taskId: 'task-2' })] };
    expect(pick([session('own'), session('same-task', { taskId: 'task-1' }), session('snoozed-task', { taskId: 'task-2' }), session('free', { taskId: 'task-3' })], board))
      .toEqual(['free']);
  });

  it('puts the newest answer first', () => {
    expect(pick([
      session('old', { attention: { kind: 'done', reason: null, at: EARLY } }),
      session('new', { attention: { kind: 'done', reason: null, at: LATE } }),
    ])).toEqual(['new', 'old']);
  });
});

describe('answerLine', () => {
  it('is the reply\'s own line first', () => {
    expect(answerLine(session('a', { lastReply: 'The fold is merged.', attention: { kind: 'done', reason: 'Report ready.', at: LATE } }))).toBe('The fold is merged.');
  });

  it('is the first line of the reported status without a reply line, or "Answered" without either', () => {
    expect(answerLine(session('a', { attention: { kind: 'done', reason: 'Report ready.\nMore below.', at: LATE } }))).toBe('Report ready.');
    expect(answerLine(session('a', { attention: null, resultAt: LATE }))).toBe('Answered');
  });
});

describe('readBefore', () => {
  it('keeps the read state each session had, for Undo', () => {
    expect(readBefore([session('a', { readAt: EARLY, resultAt: LATE }), session('b')]))
      .toEqual([{ id: 'a', readAt: EARLY, resultAt: LATE }, { id: 'b', readAt: null, resultAt: null }]);
  });
});

describe('unreadFoldOpen', () => {
  it('is folded while something needs you and open when nothing does', () => {
    expect(unreadFoldOpen(null, 2)).toBe(false);
    expect(unreadFoldOpen(null, 0)).toBe(true);
  });

  it('a toggle by hand wins for the visit', () => {
    expect(unreadFoldOpen(true, 2)).toBe(true);
    expect(unreadFoldOpen(false, 0)).toBe(false);
  });
});
