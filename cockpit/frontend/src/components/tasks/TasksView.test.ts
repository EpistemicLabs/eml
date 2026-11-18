// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import { agentStates, inboxItems, snoozeTimes, waitReason } from './TasksView';
import { buildOverview, toOverviewTask, type RawTask } from '@/lib/tasks-overview';

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


describe('why an agent task waits', () => {
  const t = (raw: Partial<RawTask> & { id: string }) => toOverviewTask({ title: raw.id, content: '', status: 'planned', scope: 'project.x', updated_at: '2026-11-18T00:00:00Z', ...raw }, { id: 'main', name: 'Main' }, new Map());
  it('names the runner\'s reason: parent not active, dependency, no project, stopped worker', () => {
    const tasks = [
      t({ id: 'chatgpt-ads', status: 'planned' }),
      t({ id: 'research', parent_id: 'chatgpt-ads', properties: { checkpoint: 'after' } }),
      t({ id: 'trial', scope: 'entity.online-pen', properties: { checkpoint: 'before' } }),
      t({ id: 'bill', parent_id: 'trial', properties: { checkpoint: 'before', depends_on: ['trial'] } }),
      t({ id: 'kit-v4', status: 'active' }),
      t({ id: 'ready', properties: { checkpoint: 'after' } }),
    ];
    const o = buildOverview({ open: tasks, resolved: [], jobs: [], sessions: [], now: new Date('2026-11-18T12:00:00Z') });
    const all = [...o.yourTurn, ...o.running, ...o.active, ...o.planned];
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const why = (id: string) => waitReason(all.find((i) => i.task.id === id)!, byId, new Set(['kit-v4']));
    expect(why('chatgpt-ads')).toBe('Step research: Waits for its parent task to be active (now planned)');
    expect(why('trial')).toBe('No project (entity.online-pen): the runner cannot start it');
    expect(why('kit-v4')).toBe('Worker stopped without finishing: continue its session');
    expect(why('ready')).toBe('Starts within a minute (at most 3 run at a time)');
  });
});
