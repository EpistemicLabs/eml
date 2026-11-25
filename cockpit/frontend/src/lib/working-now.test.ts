import { describe, expect, it } from 'vitest';

import type { AllSession } from '@/components/sidebar/allSessions';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';

import type { Board, BoardTask } from './task-board';
import { nextRuns, workingFor, workingNow } from './working-now';

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
  it('says minutes, then hours', () => {
    expect(workingFor('2026-02-01T11:56:00.000Z', NOW)).toBe('4 min');
    expect(workingFor('2026-02-01T10:55:00.000Z', NOW)).toBe('1 h 05');
    expect(workingFor(null, NOW)).toBe('');
  });
});
