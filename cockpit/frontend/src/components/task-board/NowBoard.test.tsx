// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { Board, BoardTask } from '@/lib/task-board';

import { NowBoard } from './NowBoard';

const now = Date.parse('2026-02-01T12:00:00.000Z');
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'rescue-acme', displayTitle: 'Rescue Acme', status: 'active', parentId: null, updatedAt: '2026-02-01T11:00:00.000Z',
  turn: 'agent_scheduled', group: 'mission', coverage: { ok: true, how: 'checks_back' }, urgency: 0, important: false, sessionIds: [], working: false,
  nextRunAt: '2026-02-01T17:00:00.000Z', hasSchedule: true, owner: 'lasse', delegate: 'atlas', ...patch,
});
const board = (t: BoardTask): Board => ({
  at: '2026-02-01T12:00:00.000Z', viewer: 'lasse',
  spaces: [{ id: 'main', name: 'Main', agents: ['atlas'] }],
  projects: [{ spaceId: 'main', id: 'acme', name: 'Acme', goal: null }],
  tasks: [t], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 },
});
const noop = () => {};

afterEach(cleanup);

describe('the Now card', () => {
  it('adds a line while a command of its session still runs', () => {
    render(<NowBoard board={board(task({ commands: [{ description: 'Run the tests', since: '2026-02-01T11:48:00.000Z' }] }))} now={now} onOpen={noop} movedId={null} />);
    expect(screen.getByText('Rescue Acme')).toBeTruthy();
    expect(screen.getByText('A command is still running (Run the tests, 12 min); the session continues when it finishes.')).toBeTruthy();
  });

  it('has no such line while none runs', () => {
    render(<NowBoard board={board(task())} now={now} onOpen={noop} movedId={null} />);
    expect(screen.getByText('Rescue Acme')).toBeTruthy();
    expect(screen.queryByText(/still running/)).toBeNull();
  });
});
