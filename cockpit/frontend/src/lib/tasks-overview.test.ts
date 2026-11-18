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

describe('projects in the Tasks view', () => {
  it('groups open tasks by project, the busy ones first, and folds the quiet ones', async () => {
    const { groupByProject } = await import('./tasks-overview');
    const t = (id: string, scope: string, extra: Partial<RawTask> = {}) => task({ id, scope, ...extra });
    const o = buildOverview({
      now, resolved: [], jobs: [],
      sessions: [{ taskId: 'run', sessionId: 's', name: 'S', working: true }],
      open: [
        t('old', 'project.archive', { updated_at: '2026-10-01T00:00:00Z' }),
        t('run', 'project.shop', { updated_at: '2026-10-01T00:00:00Z' }),
        t('ask', 'project.website', { updated_at: '2026-10-01T00:00:00Z', properties: { waiting_on: { who: 'lasse', why: 'go?', since: 's' } } }),
        t('due', 'project.ops', { updated_at: '2026-10-01T00:00:00Z', properties: { due_date: '2026-11-17' } }),
        t('fresh', 'project.website', { updated_at: '2026-11-16T00:00:00Z' }),
        t('loose', 'global', { updated_at: '2026-11-16T00:00:00Z' }),
      ],
    });
    const groups = groupByProject(o, now);
    expect(groups.map((g) => [g.brainId, g.active])).toEqual([
      ['website', true], ['shop', true], ['ops', true], [null, true], ['archive', false],
    ]);
    expect(groups[0]).toMatchObject({ name: 'Qualimero website', waiting: 1, running: 0 });
    expect(groups[0].items.map((i) => i.task.id)).toEqual(['ask', 'fresh']);
    expect(groups.find((g) => g.brainId === null)!.name).toBe('No project');
  });
});

describe('my tasks and cycles', () => {
  it('puts each task in the first Focus group it fits', async () => {
    const { focusGroups } = await import('./tasks-overview');
    const o = buildOverview({
      now, resolved: [], jobs: [], sessions: [{ taskId: 'run', sessionId: 's', name: 'S', working: true }],
      open: [
        task({ id: 'ask', properties: { waiting_on: { who: 'lasse', why: 'go?', since: 's' }, priority: 'urgent' } }),
        task({ id: 'urgent', properties: { priority: 'urgent' } }),
        task({ id: 'due', status: 'planned', properties: { due_date: '2026-11-17' } }),
        task({ id: 'blocker', status: 'planned' }),
        task({ id: 'waits', status: 'planned', properties: { depends_on: ['blocker'] } }),
        task({ id: 'cycle', status: 'planned', subjects: ['cycle-2026-w47'] }),
        task({ id: 'run' }),
        task({ id: 'fresh', updated_at: '2026-11-16T00:00:00Z' }),
        task({ id: 'stale', updated_at: '2026-09-01T00:00:00Z' }),
        task({ id: 'idea', status: 'planned' }),
      ],
    });
    const f = focusGroups(o, 'cycle-2026-w47', now);
    const ids = (list: { task: { id: string } }[]) => list.map((i) => i.task.id).sort();
    expect(ids(f.needsYou)).toEqual(['ask']);
    expect(ids(f.urgentDue)).toEqual(['due', 'urgent']);
    expect(ids(f.blocking)).toEqual(['blocker']);
    expect(ids(f.thisCycle)).toEqual(['cycle']);
    expect(ids(f.inProgress)).toEqual(['fresh', 'run']);
    expect(ids(f.backlog)).toEqual(['idea', 'stale', 'waits']);
  });

  it('counts a cycle\'s done of all, and how often a task was carried', async () => {
    const { cycleProgress, carried } = await import('./tasks-overview');
    const open = [task({ id: 'a', subjects: ['cycle-2026-w46', 'cycle-2026-w47'] }), task({ id: 'b', status: 'planned', subjects: ['cycle-2026-w47'] }), task({ id: 'c' })];
    const resolved = [task({ id: 'd', status: 'resolved', subjects: ['cycle-2026-w47'] })];
    expect(cycleProgress(open, resolved, 'cycle-2026-w47')).toEqual({ done: 1, total: 3, inProgress: 1 });
    expect(carried(open[0])).toBe(1);
    expect(carried(open[1])).toBe(0);
  });
});

describe('needs you follows the sessions', () => {
  it('counts a task only while a session on it or its steps waits, whatever an old handoff left', async () => {
    const { focusGroups } = await import('./tasks-overview');
    const o = buildOverview({
      now, resolved: [], jobs: [], sessions: [],
      open: [
        task({ id: 'stale', properties: { waiting_on: { who: 'lasse', why: 'old question?', since: 's' } } }),
        task({ id: 'live' }),
        task({ id: 'parent' }),
        task({ id: 'step', parent_id: 'parent', status: 'planned' }),
      ],
    });
    const f = focusGroups(o, null, now, (id) => id === 'live' || id === 'step');
    expect(f.needsYou.map((i) => i.task.id).sort()).toEqual(['live', 'parent']);
    expect(f.needsYou.find((i) => i.task.id === 'stale')).toBeUndefined();
  });
});

describe('tasks handled by agents', () => {
  it('counts running and stopped agent sessions, jobs, runner steps and agent assignees, not the user\'s tasks', async () => {
    const { agentTasks } = await import('./tasks-overview');
    const reasons = agentTasks({
      tasks: [
        task({ id: 'step', parent_id: 'p', status: 'planned', properties: { checkpoint: 'after' } }),
        task({ id: 'started-step', parent_id: 'p', status: 'active', properties: { checkpoint: 'after' } }),
        task({ id: 'atlas', properties: { assignee_ids: ['atlas'] } }),
        task({ id: 'mine', properties: { assignee_ids: ['lasse'] } }),
      ],
      jobs: [{ id: 'j', name: 'Weekly', taskId: 'weekly', nextRun: null, paused: false, ended: false }, { id: 'old', name: 'Old', taskId: 'gone', nextRun: null, paused: false, ended: true }],
      agentSessions: [{ taskId: 'busy', working: true }, { taskId: 'weekly', working: true }, { taskId: 'idle-worker', working: false }],
      agents: ['atlas'],
    });
    expect(Object.fromEntries(reasons)).toEqual({ busy: 'running', weekly: 'running', 'idle-worker': 'running', step: 'step', atlas: 'assigned' });
  });
});
