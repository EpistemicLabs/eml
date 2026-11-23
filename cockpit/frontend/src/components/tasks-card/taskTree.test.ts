import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { Board, BoardTask } from '@/lib/task-board';

import { buildTaskTree, moreOpenTasks, taskState, type TreeInput, type TreeNode } from './taskTree';

const task = (id: string, patch: Partial<BoardTask> = {}): BoardTask => ({
  id, spaceId: 'main', spaceName: 'Main', project: 'ui', title: id, status: 'active', parentId: null, originId: null, rel: null,
  updatedAt: null, turn: 'needs_you', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false,
  sessionIds: [], working: false, nextRunAt: null, ...patch,
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
    allSessions: true,
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
    const onlyOpen = buildTaskTree(input({ board: board(many), sessions: two, desk: desk('a'), allSessions: false }));
    expect(onlyOpen[0].nodes[0].sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('with only the desk\'s sessions, keeps just the branches that lead to one', () => {
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions, desk: desk('s-owner'), allSessions: false }));
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
  });
});

describe('more open tasks of a section\'s project', () => {
  it('counts the open tasks of the project its trees leave out', () => {
    const tasks = [task('root', { sessionIds: ['s1'] }), task('other'), task('closed', { status: 'resolved' }), task('elsewhere', { project: 'code' })];
    const [ui] = buildTaskTree(input({ board: board(tasks), sessions: [session('s1', { taskId: 'root' })], desk: desk('s1') }));
    expect(ui.project).toEqual({ spaceId: 'main', id: 'ui' });
    expect(moreOpenTasks(ui, tasks)).toBe(1);
  });
});
