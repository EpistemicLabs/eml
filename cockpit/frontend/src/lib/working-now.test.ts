import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';

import type { Board, BoardTask, ClosedTask } from './task-board';
import { commandLine, commandsNote, nextRuns, workingCount, workingFor, workingNow } from './working-now';

const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const space = { id: 'space', name: 'Main', main: true, agent: 'atlas', upgrade: null, shared: false, agentName: 'Atlas' } as SpaceInfo;
const session = (id: string, fields: Partial<AllSession> = {}): AllSession => ({ id, spaceId: 'space', createdAt: '2026-02-01T08:00:00.000Z', summary: `Session ${id}`, ...fields });
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'space', spaceName: 'Main', project: 'acme', title: 'acme-rescue', displayTitle: 'Rescue Acme', status: 'active', parentId: null, updatedAt: null,
  turn: 'agent_working', coverage: { ok: true, how: 'working' }, urgency: 0, important: false, sessionIds: [], working: true, nextRunAt: null, hasSchedule: false, ...patch,
});
const board = (tasks: BoardTask[]): Pick<Board, 'tasks' | 'projects'> => ({ tasks, projects: [{ spaceId: 'space', id: 'acme', name: 'Acme' }] as Board['projects'] });
const working = (since: string): TurnInfo => ({ state: 'working', since });

describe('workingNow', () => {
  it('lists only sessions working now, oldest turn first', () => {
    const rows = workingNow(
      [session('late'), session('idle'), session('early'), session('put-away', { archivedAt: '2026-02-01T11:00:00.000Z' })],
      { late: working('2026-02-01T11:50:00.000Z'), early: working('2026-02-01T11:00:00.000Z'), idle: { state: 'idle', since: '2026-02-01T11:00:00.000Z' }, 'put-away': working('2026-02-01T10:00:00.000Z') },
      board([]), [space],
    );
    expect(rows.map((r) => r.key)).toEqual(['early', 'late']);
  });

  it('names a session by its task and says where it runs and what it does', () => {
    const t = task({ sessionIds: ['w'], statusLine: { now: 'Drafting the reply', next: null, at: '2026-02-01T11:55:00.000Z' } });
    const [row] = workingNow([session('w', { worker: true })], { w: working('2026-02-01T11:00:00.000Z') }, board([t]), [space]);
    expect(row).toMatchObject({ name: 'Rescue Acme', where: 'Main · Acme', kind: 'worker', letter: 'A', step: 'Drafting the reply', sessionId: 'w' });
    expect(row.task?.id).toBe('t');
  });

  it('says so when a session only waits for its subagents, and stops saying it when its turn runs again', () => {
    const since = '2026-02-01T11:00:00.000Z';
    const t = task({ sessionIds: ['w'], statusLine: { now: 'Grading the batches', next: null, at: since } });
    const [waiting] = workingNow([session('w')], { w: { state: 'working', since, helpers: 2 } }, board([t]), [space]);
    expect(waiting).toMatchObject({ waiting: 'Waiting for 2 subagents', step: 'Grading the batches', since });
    const [one] = workingNow([session('w')], { w: { state: 'working', since, helpers: 1 } }, board([t]), [space]);
    expect(one.waiting).toBe('Waiting for 1 subagent');
    const [back] = workingNow([session('w')], { w: working(since) }, board([t]), [space]);
    expect(back.waiting).toBeNull();
  });

  it('says so when a session waits for a workflow run, with how far its agents are', () => {
    const since = '2026-02-01T11:00:00.000Z';
    const workflows = [{ name: 'review-changes', running: 3, done: 4 }];
    const [row] = workingNow([session('w')], { w: { state: 'working', since, workflows } }, board([]), [space]);
    expect(row.waiting).toBe('Waiting for review-changes · 3 agents running, 4 done');
  });

  it('keeps a desk session without a task, by its own name', () => {
    const [row] = workingNow([session('d')], { d: working('2026-02-01T11:00:00.000Z') }, board([]), [space]);
    expect(row).toMatchObject({ name: 'Session d', kind: 'desk', step: null });
  });

  it('adds a run on another member\'s cockpit from the board, opened through its task', () => {
    const t = task({ runs: [
      { id: 'r1', member: 'dominik', agent: 'motti', state: 'running', lastActivityAt: null, here: false },
      { id: 'r2', member: 'dominik', agent: 'motti', state: 'idle', lastActivityAt: null, here: false },
      { id: 'mine', member: 'lasse', agent: 'atlas', state: 'running', lastActivityAt: null, here: true },
    ] });
    const rows = workingNow([], {}, board([t]), [space]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'member', member: 'dominik', sessionId: null, letter: 'M', name: 'Rescue Acme' });
  });

  describe('a session whose task is closed', () => {
    const closedAt = '2026-02-01T11:30:00.000Z';
    const stale = working('2026-02-01T11:00:00.000Z');
    const closed = (status: string): ClosedTask => ({
      id: 't', spaceId: 'space', spaceName: 'Main', project: 'acme', title: 'acme-rescue', status, closedAt, parentId: null, originId: null, sessionIds: ['w'],
    });

    it('leaves with a turn from before the close, whatever its state still says', () => {
      for (const status of ['resolved', 'invalidated']) {
        const onBoard = task({ sessionIds: ['w'], status, updatedAt: closedAt });
        expect(workingNow([session('w', { taskId: 't' })], { w: stale }, board([onBoard]), [space])).toEqual([]);
        expect(workingNow([session('w', { taskId: 't' })], { w: stale }, { ...board([]), closed: [closed(status)] }, [space])).toEqual([]);
      }
    });

    it('stays while the same turn runs on an open task', () => {
      const rows = workingNow([session('w', { taskId: 't' })], { w: stale }, board([task({ sessionIds: ['w'], updatedAt: closedAt })]), [space]);
      expect(rows.map((r) => r.key)).toEqual(['w']);
    });

    it('stays with a turn that started after the close, such as one a message woke', () => {
      const rows = workingNow([session('w', { taskId: 't' })], { w: working('2026-02-01T11:45:00.000Z') }, { ...board([]), closed: [closed('invalidated')] }, [space]);
      expect(rows.map((r) => r.key)).toEqual(['w']);
    });
  });
});

describe('a session waiting for a command', () => {
  const tests = { description: 'Run the tests', since: '2026-02-01T11:48:00.000Z' };
  const build = { description: 'Build the app', since: '2026-02-01T09:30:00.000Z' };
  const done = (commands = [tests]): TurnInfo => ({ state: 'done', since: '2026-02-01T11:50:00.000Z', commands });

  it('is a row while its command runs, named like a working one, and leaves once the command ended', () => {
    const t = task({ sessionIds: ['w'], working: false, turn: 'agent_scheduled' });
    const [row] = workingNow([session('w', { state: 'running' })], { w: done() }, board([t]), [space]);
    expect(row).toMatchObject({ key: 'w', name: 'Rescue Acme', since: tests.since, waiting: null, command: { label: 'Waiting for a command', ...tests } });
    expect(commandLine(row.command!, NOW)).toBe('Waiting for a command · Run the tests · 12 min');
    expect(workingNow([session('w', { state: 'running' })], { w: { state: 'done', since: tests.since } }, board([t]), [space])).toEqual([]);
  });

  it('names the longest-running of several commands, and sorts by it', () => {
    const rows = workingNow(
      [session('busy'), session('w', { state: 'running' })],
      { busy: working('2026-02-01T10:00:00.000Z'), w: done([tests, build]) },
      board([]), [space],
    );
    expect(rows.map((r) => r.key)).toEqual(['w', 'busy']);
    expect(rows[0].command).toEqual({ label: 'Waiting for 2 commands', ...build });
    expect(commandLine(rows[0].command!, NOW)).toBe('Waiting for 2 commands · Build the app · 2 h 30');
  });

  it('stays a row however long the command runs', () => {
    const old = { description: 'Watch the logs', since: '2026-01-29T08:00:00.000Z' };
    const [row] = workingNow([session('w', { state: 'running' })], { w: done([old]) }, board([]), [space]);
    expect(commandLine(row.command!, NOW)).toBe('Waiting for a command · Watch the logs · 3 d 4 h');
  });

  it('is no row while it asks the user or a working turn runs, where the working row says the rest', () => {
    const asks = session('q', { state: 'running', attention: { kind: 'question', reason: null, at: '2026-02-01T11:55:00.000Z' } });
    expect(workingNow([asks], { q: done() }, board([]), [space])).toEqual([]);
    const [row] = workingNow([session('w')], { w: { ...done(), state: 'working', since: '2026-02-01T11:59:00.000Z' } }, board([]), [space]);
    expect(row).toMatchObject({ command: null, since: '2026-02-01T11:59:00.000Z' });
  });

  it('is counted apart in the header', () => {
    const rows = workingNow([session('a'), session('b'), session('w', { state: 'running' })], { a: working(tests.since), b: working(tests.since), w: done() }, board([]), [space]);
    expect(workingCount(rows)).toBe('2 working · 1 waiting for a command');
    expect(workingCount(rows.filter((r) => !r.command))).toBe('2');
  });
});

describe('commandsNote', () => {
  it('adds one line to a task whose session waits for its commands', () => {
    const tests = { description: 'Run the tests', since: '2026-02-01T11:48:00.000Z' };
    const build = { description: 'Build the app', since: '2026-02-01T09:30:00.000Z' };
    expect(commandsNote(task(), NOW)).toBeNull();
    expect(commandsNote(task({ commands: [tests] }), NOW)).toBe('A command is still running (Run the tests, 12 min); the session continues when it finishes.');
    expect(commandsNote(task({ commands: [build, tests] }), NOW)).toBe('2 commands are still running; the session continues when they finish.');
  });
});

describe('nextRuns', () => {
  it('lists scheduled tasks soonest first, without the ones working now', () => {
    const list = nextRuns({ tasks: [
      task({ id: 'b', working: false, nextRunAt: '2026-02-03T09:00:00.000Z' }),
      task({ id: 'a', working: false, nextRunAt: '2026-02-02T09:00:00.000Z' }),
      task({ id: 'busy', working: true, nextRunAt: '2026-02-01T13:00:00.000Z' }),
      task({ id: 'none', working: false }),
    ] });
    expect(list.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('workingFor', () => {
  it('says minutes, then hours, then days', () => {
    expect(workingFor('2026-02-01T11:15:00.000Z', NOW)).toBe('45 min');
    expect(workingFor('2026-02-01T10:55:00.000Z', NOW)).toBe('1 h 05');
    expect(workingFor('2026-01-31T12:01:00.000Z', NOW)).toBe('23 h 59');
    expect(workingFor('2026-01-30T08:00:00.000Z', NOW)).toBe('2 d 4 h');
    expect(workingFor(null, NOW)).toBe('');
  });
});
