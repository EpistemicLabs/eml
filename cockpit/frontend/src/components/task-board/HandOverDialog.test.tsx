// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BoardTask } from '@/lib/task-board';

import { HandOverDialog } from './HandOverDialog';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'fix-sync', status: 'active', parentId: null, updatedAt: null,
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, owner: 'lasse', goal: 'Orders sync', ...patch,
});
const open = (t: BoardTask, mode: 'now' | 'together' = 'now') => {
  const onSubmit = vi.fn();
  render(<HandOverDialog task={t} mode={mode} agents={['atlas']} desks={[{ id: 'd1', name: 'Main' }]} now={NOW} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
  return onSubmit;
};
afterEach(cleanup);

describe('the hand-over dialog', () => {
  it('continues the task\'s own session by default and says so; Start fresh asks for a new session', () => {
    const onSubmit = open(task({ ownSession: { sessionId: 's1', continues: true } }));
    expect(screen.getByText(/carries on in the task's session/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Atlas' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ mode: 'now', delegate: 'atlas', checkpoint: 'after' }, null);
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(screen.getByText(/starts in a new session, from the task's journal/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate to Atlas' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ mode: 'now', delegate: 'atlas', checkpoint: 'after', fresh: true }, null);
  });

  it('says a new session starts when there is no session to continue, without the choice', () => {
    open(task());
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();
    expect(screen.getByText(/starts in a new session, from the task's journal/)).toBeTruthy();
    cleanup();
    open(task({ ownSession: { sessionId: 's1', continues: false, why: 'terminal' } }));
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();
    expect(screen.getByText(/starts in a new session \(its session runs in a terminal\)/)).toBeTruthy();
    cleanup();
    open(task({ ownSession: { sessionId: 's1', continues: false, why: 'long_context' } }));
    expect(screen.getByText(/starts in a new session \(its session is very long\)/)).toBeTruthy();
  });

  it('calls working on it yourself Take over whenever the task has its own session, as the host decides it', () => {
    open(task({ ownSession: { sessionId: 's1', continues: true } }), 'together');
    expect(screen.getByText('Open its session in which desk?')).toBeTruthy();
    cleanup();
    open(task(), 'together');
    expect(screen.getByText('Open the panel in which desk?')).toBeTruthy();
  });

  it('on a task the agent works on alone with its own session, working on it yourself is Take over', () => {
    const onSubmit = open(task({ delegate: 'atlas', ownSession: { sessionId: 's1', continues: true } }), 'together');
    expect(screen.getByText(/The task's session opens in a new pane/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Take over' }).at(-1)!);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'together', desk: 'Main' }), { id: 'd1' });
  });
});
