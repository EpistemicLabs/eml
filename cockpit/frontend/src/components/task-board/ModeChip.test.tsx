// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Board, BoardTask } from '@/lib/task-board';

const live = vi.hoisted(() => ({ board: undefined as unknown, calls: [] as Array<{ kind: string; body: unknown }> }));
vi.mock('@/lib/task-board', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/task-board')>();
  const answer = { ok: true as const, opId: 'op', state: 'pending', undoUntil: new Date(Date.now() + 8000).toISOString() };
  return {
    ...real,
    useTaskBoard: () => ({ data: live.board, refetch: async () => {} }),
    handOver: async (_t: unknown, input: unknown) => { live.calls.push({ kind: 'hand_over', body: input }); return answer; },
    takeOver: async (t: { id: string }) => { live.calls.push({ kind: 'take_over', body: t.id }); return answer; },
  };
});

import { ModeChip, modeAction } from './ModeChip';

const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'fix-sync', status: 'active', parentId: null, updatedAt: null,
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: ['s1'], working: false, nextRunAt: null, hasSchedule: false, owner: 'lasse', ...patch,
});
const boardOf = (t: BoardTask): Board => ({
  at: new Date().toISOString(), viewer: 'lasse', spaces: [{ id: 'main', name: 'Main', agents: ['atlas'] }], projects: [],
  tasks: [t], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 },
});
afterEach(() => { cleanup(); live.calls = []; });

describe('the mode chip', () => {
  it('offers the one action that switches the mode: Take over when the agent works alone, Delegate with a name and a goal', () => {
    expect(modeAction(task({ delegate: 'atlas' }), ['atlas'])?.label).toBe('Take over');
    expect(modeAction(task({ goal: 'Orders sync', checkpoint: 'before' }), ['atlas'])?.label).toBe('Delegate to Atlas (checkpoint before)');
    expect(modeAction(task(), ['atlas'])).toBeNull();
    expect(modeAction(task({ goal: 'x', title: 'session-2026-11-25-2ee4035f' }), ['atlas'])).toBeNull();
    expect(modeAction(task({ goal: 'x' }), [])).toBeNull();
  });

  it('shows the mode beside the task and switches it from its menu', async () => {
    live.board = boardOf(task({ delegate: 'atlas' }));
    render(<ModeChip taskId="t" />);
    fireEvent.click(screen.getByRole('button', { name: 'Atlas works alone: change' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take over' }));
    await vi.waitFor(() => expect(live.calls).toEqual([{ kind: 'take_over', body: 't' }]));
    await vi.waitFor(() => expect(screen.getByText(/Taken over: Atlas finishes the turn/)).toBeTruthy());
  });

  it('a task with you without a goal shows the mode only, and a closed or unknown task nothing', () => {
    live.board = boardOf(task());
    render(<ModeChip taskId="t" />);
    expect(screen.getByText('With you')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    live.board = boardOf(task({ status: 'resolved' }));
    const { container } = render(<ModeChip taskId="t" />);
    expect(container.textContent).toBe('');
  });
});
