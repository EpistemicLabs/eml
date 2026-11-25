// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Board, BoardTask } from '@/lib/task-board';

// Only the board is faked: the actions go through the page's real calls to the host (fetch).
const live = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock('@/lib/task-board', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/task-board')>();
  return { ...real, useTaskBoard: () => ({ data: live.board, refetch: async () => {} }) };
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
const own = { sessionId: 's1', continues: true };

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let refuse: { code: string; message: string } | null = null;
beforeEach(() => {
  // jsdom has no stylesheet: a message without a deadline stays as long as the token says.
  document.documentElement.style.setProperty('--duration-toast', '5s');
  calls = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (refuse) return new Response(JSON.stringify({ error: { ...refuse, retry: false } }), { status: 409 });
    return new Response(JSON.stringify({ opId: 'op-1', state: 'pending', undoUntil: new Date(Date.now() + 8000).toISOString() }), { status: 202 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the mode chip', () => {
  it('offers Take over only in the task\'s own session, and Delegate on a task with you that has a name and a goal', () => {
    expect(modeAction(task({ delegate: 'atlas', ownSession: own }), ['atlas'], 's1')?.label).toBe('Take over');
    // a helper's or a job's session, or any other one on the task: Take over would take over another session
    expect(modeAction(task({ delegate: 'atlas', ownSession: own }), ['atlas'], 'helper')).toBeNull();
    expect(modeAction(task({ delegate: 'atlas' }), ['atlas'], 's1')).toBeNull();
    expect(modeAction(task({ goal: 'Orders sync', checkpoint: 'before' }), ['atlas'], 's1')?.label).toBe('Delegate to Atlas (checkpoint before)');
    expect(modeAction(task(), ['atlas'], 's1')).toBeNull();
    expect(modeAction(task({ goal: 'x', title: 'session-2026-11-25-2ee4035f' }), ['atlas'], 's1')).toBeNull();
    expect(modeAction(task({ goal: 'x' }), [], 's1')).toBeNull();
  });

  it('says whether Delegate carries on in this session, in the task\'s own one, or in a new one', () => {
    const t = (o?: BoardTask['ownSession']) => task({ goal: 'x', ...(o ? { ownSession: o } : {}) });
    expect(modeAction(t(own), ['atlas'], 's1')?.done).toBe('Delegated: Atlas carries on in this session alone once Undo is over.');
    expect(modeAction(t(own), ['atlas'], 'other')?.done).toBe('Delegated: Atlas carries on in the task\'s own session once Undo is over.');
    expect(modeAction(t({ sessionId: 's1', continues: false }), ['atlas'], 's1')?.done).toBe('Delegated: Atlas starts in a new session once Undo is over.');
    expect(modeAction(t(), ['atlas'], 's1')?.done).toBe('Delegated: Atlas starts in a new session once Undo is over.');
  });

  it('takes the task over from its own session\'s header, and Undo puts it back', async () => {
    live.board = boardOf(task({ delegate: 'atlas', checkpoint: 'after', ownSession: own }));
    render(<ModeChip taskId="t" sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Atlas works alone: change' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take over' }));
    await vi.waitFor(() => expect(screen.getByText('Taken over: Atlas finishes the turn it is in, then the session is yours.')).toBeTruthy());
    expect(calls[0]).toMatchObject({ url: '/api/v1/tasks/t/hand-over', body: { spaceId: 'main', mode: 'together', delegate: 'atlas', checkpoint: 'after' } });
    expect(calls[0].body).not.toHaveProperty('desk');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await vi.waitFor(() => expect(calls[1]?.url).toBe('/api/v1/commands/op-1/undo'));
    await vi.waitFor(() => expect(screen.getByText('Undone. The task is back as it was.')).toBeTruthy());
  });

  it('delegates from the header with the task\'s agent and checkpoint, and shows why when the host refuses', async () => {
    live.board = boardOf(task({ goal: 'Orders sync', checkpoint: 'none', ownSession: own }));
    render(<ModeChip taskId="t" sessionId="s1" />);
    refuse = { code: 'task_closed', message: 'The task is closed.' };
    fireEvent.click(screen.getByRole('button', { name: 'With you: change' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delegate to Atlas (checkpoint none)' }));
    await vi.waitFor(() => expect(screen.getByText('The task is closed.')).toBeTruthy());
    expect(calls[0].body).toMatchObject({ mode: 'now', delegate: 'atlas', checkpoint: 'none' });
    expect(calls[0].body).not.toHaveProperty('fresh');
  });

  it('shows the mode only where no action fits, and nothing for a closed or unknown task', () => {
    live.board = boardOf(task({ delegate: 'atlas', ownSession: own }));
    render(<ModeChip taskId="t" sessionId="helper" />);
    expect(screen.getByText('Atlas works alone')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    live.board = boardOf(task({ status: 'resolved' }));
    const { container } = render(<ModeChip taskId="t" sessionId="s1" />);
    expect(container.textContent).toBe('');
  });
});
