import { describe, expect, it } from 'vitest';

import { buildOverview, matches, toOverviewTask, type OverviewTask, type RawTask } from './tasks-overview';

// The Tasks view's groups: whose turn first, then what runs, what is scheduled,
// active and planned; a task with steps shows once, with its progress, and a
// step waiting on the user puts its task in Your turn.

const space = { id: 'main', name: 'Main' };
const projects = new Map([['website', 'Qualimero website']]);
const task = (raw: Partial<RawTask> & { id: string }): OverviewTask => toOverviewTask(
  { title: raw.id, content: `do ${raw.id}`, status: 'active', scope: 'project.website', updated_at: '2026-11-17T10:00:00Z', ...raw }, space, projects,
);
const now = new Date('2026-11-17T12:00:00Z');

describe('the tasks overview', () => {
  it('reads a brain task: project name, fields, parent and wait', () => {
    const t = task({ id: 'a', parent_id: 'p', properties: { priority: 'high', checkpoint: 'before', depends_on: ['x'], waiting_on: { who: 'lasse', why: 'go?', since: 's' } } });
    expect(t).toMatchObject({ project: 'Qualimero website', parentId: 'p', priority: 'high', checkpoint: 'before', dependsOn: ['x'], waitingOn: { who: 'lasse', why: 'go?', since: 's' } });
    expect(task({ id: 'g', scope: 'global', title: null }).title).toBe('do g');
  });

  it('groups whose turn first, then running, active and planned, each task once with its steps', () => {
    const open = [
      task({ id: 'plan', properties: { priority: 'high' } }),
      task({ id: 'step-ask', parent_id: 'plan', status: 'planned', properties: { waiting_on: { who: 'lasse', why: 'which headline?', since: '2026-11-17T09:00:00Z' } } }),
      task({ id: 'step-run', parent_id: 'plan' }),
      task({ id: 'busy' }),
      task({ id: 'quiet', updated_at: '2026-11-17T11:00:00Z' }),
      task({ id: 'urgent', properties: { priority: 'urgent' } }),
      task({ id: 'later', status: 'planned' }),
      task({ id: 'orphan', parent_id: 'gone', status: 'planned' }),
    ];
    const resolved = [task({ id: 'step-done', parent_id: 'plan', status: 'resolved' }), task({ id: 'old', status: 'resolved', updated_at: '2026-11-01T00:00:00Z' })];
    const o = buildOverview({
      open, resolved, now,
      sessions: [{ taskId: 'busy', sessionId: 's1', name: 'Busy session', working: true }, { taskId: 'quiet', sessionId: 's2', name: 'Idle', working: false }],
      jobs: [{ id: 'j1', name: 'Weekly report', taskId: 'quiet', nextRun: '2026-11-20T08:00:00Z', paused: false, ended: false }, { id: 'j2', name: 'Old', taskId: null, nextRun: null, paused: false, ended: true }],
    });
    expect(o.yourTurn.map((i) => i.task.id)).toEqual(['plan']);
    expect(o.yourTurn[0]).toMatchObject({ done: 1, waiting: { why: 'which headline?', stepTitle: 'step-ask' } });
    expect(o.yourTurn[0].steps.map((s) => s.id).sort()).toEqual(['step-ask', 'step-done', 'step-run']);
    expect(o.running.map((i) => i.task.id)).toEqual(['busy']);
    expect(o.running[0].running).toEqual({ title: 'busy', sessionName: 'Busy session' });
    expect(o.active.map((i) => i.task.id)).toEqual(['urgent', 'quiet']);
    expect(o.active[1].jobs.map((j) => j.name)).toEqual(['Weekly report']);
    expect(o.planned.map((i) => i.task.id).sort()).toEqual(['later', 'orphan']);
    expect(o.scheduled.map((r) => [r.job.name, r.item?.task.id])).toEqual([['Weekly report', 'quiet']]);
    expect(o.done).toEqual([]);
    expect(o.openCount).toBe(6);
  });

  it('lists what was closed in the last seven days, newest first', () => {
    const o = buildOverview({
      open: [], sessions: [], jobs: [], now,
      resolved: [task({ id: 'a', status: 'resolved', updated_at: '2026-11-15T00:00:00Z' }), task({ id: 'b', status: 'resolved', updated_at: '2026-11-16T00:00:00Z' }), task({ id: 'old', status: 'resolved', updated_at: '2026-11-01T00:00:00Z' })],
    });
    expect(o.done.map((i) => i.task.id)).toEqual(['b', 'a']);
  });

  it('filters by space, project, priority and words', () => {
    const t = task({ id: 'hero-copy', properties: { priority: 'high' } });
    expect(matches(t, { spaceId: null, project: null, priority: null, words: '' })).toBe(true);
    expect(matches(t, { spaceId: 'eml', project: null, priority: null, words: '' })).toBe(false);
    expect(matches(t, { spaceId: null, project: 'Qualimero website', priority: 'high', words: 'HERO do' })).toBe(true);
    expect(matches(t, { spaceId: null, project: null, priority: 'normal', words: '' })).toBe(false);
    expect(matches(t, { spaceId: null, project: null, priority: null, words: 'pricing' })).toBe(false);
  });
});
