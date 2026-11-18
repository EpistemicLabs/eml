// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import { agentStates, inboxItems, snoozeTimes } from './TasksView';

// The Inbox shows what needs the user, without the snoozed ones; each task
// shows what its agent is doing.

const s = (id: string, extra: Partial<AllSession> = {}) => ({ id, spaceId: 'main', summary: id, state: 'running', ...extra }) as unknown as AllSession;
const now = new Date('2026-11-18T10:00:00');

describe('the Inbox and agent states', () => {
  it('lists questions, failures and reviews, oldest first, and leaves out the snoozed and archived', () => {
    const items = inboxItems([
      s('q', { attention: { kind: 'question', reason: 'go?', at: '2026-11-18T09:00:00Z' } }),
      s('f', { attention: { kind: 'failed', reason: 'broke', at: '2026-11-18T08:00:00Z' } }),
      s('snoozed', { attention: { kind: 'question', reason: 'x', at: '2026-11-18T07:00:00Z' }, snoozedUntil: '2026-11-19T09:00:00Z' }),
      s('woke', { attention: { kind: 'question', reason: 'x', at: '2026-11-18T06:00:00Z' }, snoozedUntil: '2026-11-17T09:00:00Z' }),
      s('gone', { attention: { kind: 'question', reason: 'x', at: '2026-11-18T05:00:00Z' }, archivedAt: '2026-11-18T05:30:00Z' }),
      s('quiet'),
    ], {}, now);
    expect(items.map((i) => i.id)).toEqual(['woke', 'f', 'q']);
  });

  it('gives each task the most pressing state of its sessions', () => {
    const states = agentStates([
      s('a', { taskId: 't1', attention: { kind: 'done', reason: null, at: 'x' } }),
      s('b', { taskId: 't1', attention: { kind: 'question', reason: 'go?', at: 'x' } }),
      s('c', { taskId: 't2' }),
      s('d', { taskId: 't3', attention: { kind: 'failed', reason: 'x', at: 'x' } }),
    ], { c: { state: 'working', since: 'x' } }, );
    expect(Object.fromEntries(states)).toEqual({ t1: 'needs input', t2: 'working', t3: 'error' });
  });

  it('snoozes until tomorrow or Monday at nine', () => {
    const t = snoozeTimes(now);
    expect(new Date(t.tomorrow).getDate()).toBe(19);
    expect(new Date(t.tomorrow).getHours()).toBe(9);
    expect(new Date(t.monday).getDay()).toBe(1);
    expect(new Date(t.monday).getDate()).toBe(23);
  });
});
