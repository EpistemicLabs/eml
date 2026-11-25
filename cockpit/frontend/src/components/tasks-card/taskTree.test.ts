import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { Board, BoardTask } from '@/lib/task-board';

import { buildTaskTree, deskTaskProjects, moreOpenTasks, taskState, type TaskLike, type TreeInput, type TreeNode } from './taskTree';

const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'main', spaceName: 'Main', project: 'ui', title: id, status: 'active', parentId: null, originId: null, rel: null,
  updatedAt: null, turn: 'needs_you', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false,
  sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, ...patch,
});
const session = (id: string, patch: Partial<AllSession> = {}): AllSession => ({ id, spaceId: 'main', projectId: 'p-ui', summary: id, ...patch });

const board = (tasks: BoardTask[], lineage: Board['lineage'] = []): TreeInput['board'] => ({
  tasks,
  lineage,
  projects: [{ spaceId: 'main', id: 'ui', name: 'EML UI/UX', goal: null }, { spaceId: 'main', id: 'code', name: 'EML Code', goal: null }],
});

function input(patch: Partial<TreeInput>): TreeInput {
  return {
    board: board([]),
    sessions: [],
    desk: [],
    projects: [{ spaceId: 'main', projectId: 'p-ui', brainProjectId: 'ui', name: 'EML UI/UX' }, { spaceId: 'eml', projectId: 'p-eml', name: 'EML' }],
    activeSessionId: null,
    showDone: false,
    allTasks: true,
    viewOf: () => 'terminal',
    stateOfSession: () => ({ hue: 'waiting', hollow: true, label: 'Idle' }),
    ...patch,
  };
}

const titles = (nodes: TreeNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.title, titles(n.children)] : n.title));
const desk = (...ids: string[]) => ids.map((sessionId, i) => ({ sessionId, paneId: `pane-${i}`, view: 'chat' as const }));

describe('the tasks card tree', () => {
  // root (ui) ─ spun off ─ owner (ui) ; root ─ spun off ─ loop (code) ─ sub ─ step (code)
  const tasks = [
    task('root', { sessionIds: ['s-root'] }),
    task('owner', { originId: 'root', rel: 'spun', sessionIds: ['s-owner'] }),
    task('loop', { project: 'code', originId: 'root', rel: 'spun', sessionIds: ['s-loop'] }),
    task('step', { project: 'code', parentId: 'loop', rel: 'sub', status: 'planned', turn: 'agent_scheduled' }),
  ];
  const sessions = [session('s-root', { taskId: 'root' }), session('s-owner', { taskId: 'owner' }), session('s-loop', { taskId: 'loop', projectId: 'p-code' })];

  it('starts each tree at its origin task and names a task of another project', () => {
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s-owner') }));
    expect(ui.title).toBe('EML UI/UX');
    expect(titles(ui.nodes)).toEqual([['root', ['owner', ['loop', ['step']]]]]);
    const loop = ui.nodes[0].children[1];
    expect(loop).toMatchObject({ rel: 'spun', otherProject: 'EML Code' });
    expect(loop.children[0]).toMatchObject({ rel: 'sub', otherProject: 'EML Code', state: { hollow: true } });
  });

  it('shows the same tree again in the section of another project with a session on the desk', () => {
    const sections = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s-owner', 's-loop') }));
    expect(sections.map((s) => s.title)).toEqual(['EML UI/UX', 'EML Code']);
    expect(sections[1].nodes[0]).toMatchObject({ id: 'root', otherProject: 'EML UI/UX' });
    expect(sections[0].nodes[0].key).not.toBe(sections[1].nodes[0].key);
  });

  it('lists a task\'s sessions, only the desk\'s ones when asked, and marks the active pane\'s one', () => {
    const many = [task('root', { sessionIds: ['a', 'b'] })];
    const two = [session('a', { taskId: 'root' }), session('b', { taskId: 'root' })];
    const all = buildTaskTree(input({ board: board(many), sessions: two, desk: desk('a'), activeSessionId: 'a' }));
    expect(all[0].nodes[0].sessions.map((s) => [s.id, s.open, s.current, s.view])).toEqual([['a', true, true, 'chat'], ['b', false, false, 'terminal']]);
    const onlyOpen = buildTaskTree(input({ board: board(many), sessions: two, desk: desk('a'), allTasks: false }));
    expect(onlyOpen[0].nodes[0].sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('with only the desk\'s sessions, keeps just the branches that lead to one', () => {
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s-owner'), allTasks: false }));
    expect(titles(ui.nodes)).toEqual([['root', ['owner']]]);
    expect(ui.nodes[0].sessions).toEqual([]);
  });

  it('hides done tasks unless asked, but keeps one that holds a desk session', () => {
    const withDone = [
      task('root', { sessionIds: ['s-root'] }),
      task('old', { parentId: 'root', status: 'resolved', turn: 'done' }),
      task('finished', { parentId: 'root', status: 'resolved', turn: 'done', sessionIds: ['s-fin'] }),
    ];
    const s = [session('s-root', { taskId: 'root' }), session('s-fin', { taskId: 'finished' })];
    expect(titles(buildTaskTree(input({ board: board(withDone), sessions: s, desk: desk('s-root', 's-fin') }))[0].nodes)).toEqual([['root', ['finished']]]);
    expect(titles(buildTaskTree(input({ board: board(withDone), sessions: s, desk: desk('s-root'), showDone: true }))[0].nodes)).toEqual([['root', ['old', 'finished']]]);
  });

  it('reaches a closed origin the board only has as lineage', () => {
    const b = board([task('child', { parentId: 'gone', rel: 'sub', sessionIds: ['s1'] })], [
      { id: 'gone', spaceId: 'main', project: 'ui', title: 'Old parent', status: 'resolved', parentId: null, originId: null },
    ]);
    const [ui] = buildTaskTree(input({ board: b, sessions: [session('s1', { taskId: 'child' })], desk: desk('s1') }));
    expect(titles(ui.nodes)).toEqual([['Old parent', ['child']]]);
    expect(ui.nodes[0].state).toEqual({ hue: 'done', hollow: false, label: 'Done' });
  });

  it('builds a session tree for sessions without a task: each session under the one that started it', () => {
    const s = [
      session('lead', { spaceId: 'eml', projectId: 'p-eml' }),
      session('worker', { spaceId: 'eml', projectId: 'p-eml', parentSessionId: 'lead' }),
      session('archived', { spaceId: 'eml', projectId: 'p-eml', parentSessionId: 'lead', archivedAt: '2026-11-20T00:00:00Z' }),
    ];
    const [eml] = buildTaskTree(input({ sessions: s, desk: desk('worker') }));
    expect(eml.title).toBe('EML');
    expect(titles(eml.nodes)).toEqual([['lead', ['worker']]]);
    expect(eml.nodes[0]).toMatchObject({ kind: 'session', sessions: [{ id: 'lead' }] });
    expect(eml.nodes[0].children[0].rel).toBe('sub');
  });

  it('survives a loop in the links', () => {
    const loop = [task('a', { parentId: 'b', sessionIds: ['s'] }), task('b', { parentId: 'a' })];
    expect(() => buildTaskTree(input({ board: board(loop), sessions: [session('s', { taskId: 'a' })], desk: desk('s') }))).not.toThrow();
  });
});

describe('all tasks', () => {
  // On the desk: s1 on root (ui). Not on the desk: a separate open tree in ui, a closed one in ui, one in code.
  const tasks = [
    task('root', { sessionIds: ['s1'] }),
    task('lone', { sessionIds: ['s-lone'] }),
    task('lone-step', { parentId: 'lone', rel: 'sub' }),
    task('closed', { status: 'resolved', turn: 'done' }),
    task('elsewhere', { project: 'code' }),
  ];
  const sessions = [session('s1', { taskId: 'root' }), session('s-lone', { taskId: 'lone' })];

  it('adds every open tree of the desk\'s projects with all their sessions, after the desk\'s trees', () => {
    const [ui, ...rest] = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s1'), allTasks: true }));
    expect(rest).toEqual([]);
    expect(titles(ui.nodes)).toEqual(['root', ['lone', ['Lone step']]]);
    expect(ui.nodes[1].sessions.map((s) => [s.id, s.open])).toEqual([['s-lone', false]]);
    expect(moreOpenTasks(ui, tasks)).toBe(0);
  });

  it('shows only the desk\'s trees when off', () => {
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s1'), allTasks: false }));
    expect(titles(ui.nodes)).toEqual(['root']);
    expect(moreOpenTasks(ui, tasks)).toBe(2);
  });

  it('takes the project of a desk session without a task too', () => {
    const lead = session('lead', { projectId: 'p-ui' });
    const sections = buildTaskTree(input({ board: board(tasks), sessions: [lead], desk: desk('lead'), allTasks: true }));
    expect(sections.map((s) => s.title)).toEqual(['EML UI/UX', 'EML UI/UX']);
    expect(sections[0].nodes[0]).toMatchObject({ kind: 'session', id: 'lead' });
    expect(titles(sections[1].nodes)).toEqual(['root', ['lone', ['Lone step']]]);
  });
});

describe('a session waiting for the board', () => {
  it('does not show as a bare session while its task is not on the board yet', () => {
    const sections = buildTaskTree(input({ board: board([]), sessions: [session('s1', { taskId: 'new-task' })], desk: desk('s1') }));
    expect(sections).toEqual([]);
  });
});

describe('a task\'s dot', () => {
  it('is filled while someone acts, hollow while it waits, grey when closed', () => {
    expect(taskState(task('t', { turn: 'needs_you', group: 'asked' }))).toEqual({ hue: 'you', hollow: false, label: 'Needs you' });
    expect(taskState(task('t', { turn: 'agent_working' }))).toEqual({ hue: 'agent', hollow: false, label: 'Agent working' });
    expect(taskState(task('t', { turn: 'review' }))).toEqual({ hue: 'you', hollow: false, label: 'Review' });
    expect(taskState(task('t', { turn: 'waiting_on_others' }))).toMatchObject({ hollow: true });
    expect(taskState(task('t', { turn: null, status: 'planned' }))).toEqual({ hue: 'waiting', hollow: true, label: 'Parked' });
    expect(taskState(task('t', { status: 'invalidated', turn: null }))).toEqual({ hue: 'done', hollow: false, label: 'Dropped' });
    expect(taskState(task('t', { status: 'superseded', turn: null }))).toEqual({ hue: 'done', hollow: false, label: 'Replaced' });
  });
});

describe('more open tasks of a section\'s project', () => {
  it('counts the open tasks of the project its trees leave out', () => {
    const tasks = [task('root', { sessionIds: ['s1'] }), task('other'), task('closed', { status: 'resolved' }), task('elsewhere', { project: 'code' })];
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions: [session('s1', { taskId: 'root' })], desk: desk('s1'), allTasks: false }));
    expect(ui.project).toEqual({ spaceId: 'main', id: 'ui' });
    expect(moreOpenTasks(ui, tasks)).toBe(1);
  });
});

describe('Show done in the tasks card tree', () => {
  const closedTask = (id: string, patch: Partial<TaskLike> = {}): TaskLike => ({ id, spaceId: 'main', project: 'ui', title: id, status: 'resolved', parentId: null, ...patch });
  const done = (tasks: TaskLike[], more: string[] = []) => ({ tasks, more: new Set(more) });
  const open = [task('live', { sessionIds: ['s-live'] })];
  const archived = '2026-11-20T00:00:00Z';

  it('adds each closed tree of a desk project below the open ones, newest first, with every branch and session', () => {
    const closed = done([
      closedTask('newer', { parentId: 'old-root' }),
      closedTask('old-root'),
      closedTask('dropped', { status: 'invalidated' }),
      closedTask('elsewhere', { project: 'code' }),
    ]);
    const s = [session('s-live', { taskId: 'live' }), session('s-newer', { taskId: 'newer', archivedAt: archived })];
    const [ui] = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), allTasks: false, showDone: true, closed }));
    expect(titles(ui.nodes)).toEqual(['live', ['Old root', ['newer']], 'dropped']);
    expect(ui.nodes[1].children[0].sessions.map((l) => [l.id, l.open])).toEqual([['s-newer', false]]);
    expect(ui.nodes[2].state.label).toBe('Dropped');
  });

  it('leaves closed trees and finished sessions out while it is off', () => {
    const s = [session('s-live', { taskId: 'live' }), session('gone', { archivedAt: archived })];
    const sections = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), closed: done([closedTask('old')]) }));
    expect(sections.map((x) => titles(x.nodes))).toEqual([['live']]);
  });

  it('lists finished sessions without a task in their project\'s section, grey, as trees', () => {
    const s = [
      session('s-live', { taskId: 'live' }),
      session('lead', { archivedAt: archived }),
      session('worker', { parentSessionId: 'lead', archivedAt: archived }),
      session('other-project', { projectId: 'p-code', archivedAt: archived }),
      session('running'),
    ];
    const sections = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), allTasks: false, showDone: true, closed: done([]) }));
    expect(sections.map((x) => x.key)).toEqual(['t:main/ui', 's:main/p-ui']);
    expect(titles(sections[1].nodes)).toEqual([['lead', ['worker']]]);
    expect(sections[1].nodes[0].state).toEqual({ hue: 'done', hollow: false, label: 'Finished' });
  });

  it('shows a finished session under its open task with All tasks on', () => {
    const s = [session('s-live', { taskId: 'live' }), session('s-old', { taskId: 'live', archivedAt: archived })];
    const on = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), showDone: true, closed: done([]) }));
    expect(on[0].nodes[0].sessions.map((l) => l.id)).toEqual(['s-live', 's-old']);
    const off = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), closed: done([]) }));
    expect(off[0].nodes[0].sessions.map((l) => l.id)).toEqual(['s-live']);
  });

  it('says when older closed work is left: the host\'s word for tasks, its own limit for sessions', () => {
    const s = [session('s-live', { taskId: 'live' }), ...['a', 'b', 'c'].map((id) => session(id, { archivedAt: archived }))];
    const sections = buildTaskTree(input({
      board: board(open), sessions: s, desk: desk('s-live'), showDone: true, closed: done([closedTask('old')], ['main/ui']), doneLimit: () => 2,
    }));
    expect(sections[0].doneMore).toBe(true);
    expect(titles(sections[1].nodes)).toEqual(['a', 'b']);
    expect(sections[1].doneMore).toBe(true);
    const all = buildTaskTree(input({ board: board(open), sessions: s, desk: desk('s-live'), showDone: true, closed: done([closedTask('old')]), doneLimit: () => 3 }));
    expect(all.map((x) => x.doneMore)).toEqual([undefined, undefined]);
  });

  it('starts a closed tree at its topmost closed task, not at an open one off the desk', () => {
    const b = board([...open, task('hidden-open', { sessionIds: [] })]);
    const closed = done([closedTask('closed-step', { parentId: 'hidden-open' })]);
    const [ui] = buildTaskTree(input({ board: b, sessions: [session('s-live', { taskId: 'live' })], desk: desk('s-live'), allTasks: false, showDone: true, closed }));
    expect(titles(ui.nodes)).toEqual(['live', 'Closed step']);
  });

  it('shows a closed task inside an open tree that is already there, once', () => {
    const closed = done([closedTask('finished-step', { parentId: 'live' })]);
    const [ui] = buildTaskTree(input({ board: board(open), sessions: [session('s-live', { taskId: 'live' })], desk: desk('s-live'), allTasks: false, showDone: true, closed }));
    expect(titles(ui.nodes)).toEqual([['live', ['Finished step']]]);
  });

  it('gives a desk session without a task its project\'s closed tasks too', () => {
    const sections = buildTaskTree(input({ board: board([]), sessions: [session('plain')], desk: desk('plain'), allTasks: false, showDone: true, closed: done([closedTask('old')]) }));
    expect(sections.map((x) => x.key)).toEqual(['s:main/p-ui', 't:main/ui']);
    const tasksOfUi = sections[1];
    expect(tasksOfUi).toMatchObject({ key: 't:main/ui', project: { spaceId: 'main', id: 'ui' } });
    expect(titles(tasksOfUi.nodes)).toEqual(['old']);
  });

  it('names the brain projects of the desk\'s sessions, from their task or their cockpit project', () => {
    const s = [session('a', { taskId: 'live' }), session('b', { projectId: 'p-ui' }), session('c', { spaceId: 'eml', projectId: 'p-eml' }), session('d', { taskId: 'gone' })];
    const b = board([task('live', { project: 'code' })]);
    expect(deskTaskProjects({ board: b, sessions: s, desk: desk('a', 'b', 'c', 'd'), projects: input({}).projects }))
      .toEqual([{ spaceId: 'main', project: 'code' }, { spaceId: 'main', project: 'ui' }]);
  });
});
