// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import type { Board, BoardTask } from '@/lib/task-board';

// The journal shows or hides with its engram's load; that is what moved the Related block's copies in.
const live = vi.hoisted(() => ({ engram: undefined as unknown }));
vi.mock('@/lib/queries', () => ({ useEngram: () => ({ data: live.engram }) }));
vi.mock('@/components/task-sections', () => ({ TaskJournal: () => <div>journal</div> }));
vi.mock('@/components/ui/session-chat', () => ({ SessionChat: () => null }));

import { TaskPanel } from './TaskPanel';

const NOW = Date.now();
const task = (patch: Partial<BoardTask>): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'task', status: 'active', parentId: null, updatedAt: new Date(NOW).toISOString(),
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, owner: 'lasse', ...patch,
});
const parent = task({ id: 'parent', title: 'claude-mcp-plugin-marketing-channel-research' });
const board = (p: BoardTask): Board => ({
  at: new Date(NOW).toISOString(), viewer: 'lasse',
  spaces: [{ id: 'main', name: 'Main', agents: ['atlas'] }],
  projects: [{ spaceId: 'main', id: 'acme', name: 'Acme', goal: null }],
  tasks: [p, task({ id: 'child', title: 'claude-channel-demand-check', parentId: 'parent' })],
  inbox: [], snoozed: [], events: [], counts: { needsYou: 1, inbox: 0 },
});

const client = new QueryClient();
afterEach(() => { cleanup(); live.engram = undefined; });

describe('the task panel', () => {
  it('shows the Related block once while the journal and the question box come and go', () => {
    const panel = (t: BoardTask) => (
      <MemoryRouter><QueryClientProvider client={client}>
        <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onReopen={() => {}} />
      </QueryClientProvider></MemoryRouter>
    );
    const { rerender } = render(panel(parent));
    for (let i = 0; i < 8; i++) {
      live.engram = i % 2 === 0 ? { id: 'parent' } : undefined;
      const t = i % 3 === 0 ? { ...parent, group: 'asked' as const, waitingOn: { who: 'lasse', kind: 'question' as const, why: 'Go?' } } : { ...parent };
      rerender(panel(t));
      expect(screen.getAllByRole('heading', { name: 'Related' })).toHaveLength(1);
      expect(screen.getAllByRole('tree', { name: 'Related tasks' })).toHaveLength(1);
    }
  });

  describe('a closed task', () => {
    const closed = (patch: Partial<BoardTask>) => task({ id: 'c', status: 'invalidated', turn: null, group: undefined, closedAt: new Date(NOW).toISOString(), outcome: 'Not needed', delegate: 'atlas', checkpoint: 'after', ...patch });
    const show = (t: BoardTask, onReopen = vi.fn(), viewer = 'lasse') => {
      render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={t} board={{ ...board(parent), viewer, closed: [] }} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onReopen={onReopen} />
        </QueryClientProvider></MemoryRouter>,
      );
      return onReopen;
    };

    it('says how it ended and reopens with the reason; no hand-over buttons', () => {
      const onReopen = show(closed({}));
      expect(screen.getByText('Dropped')).toBeTruthy();
      expect(screen.getByText(/Not needed/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Delegate now|Run Atlas now/ })).toBeNull();
      fireEvent.change(screen.getByRole('textbox', { name: 'Why reopen (optional)' }), { target: { value: 'found a bug' } });
      fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
      expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), 'found a bug');
    });

    it('offers no Reopen to someone else, nor for a replaced task or one under a closed parent', () => {
      show(closed({ owner: 'dominik' }));
      expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
      expect(screen.getByText(/Only its owner \(dominik\)/)).toBeTruthy();
      cleanup();
      show(closed({ blocked: 'superseded', status: 'superseded' }));
      expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
      expect(screen.getByText(/Another task replaced it/)).toBeTruthy();
      cleanup();
      show(closed({ blocked: 'parent_closed', parentId: 'gone' }));
      expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
      expect(screen.getByText(/reopen the parent first/)).toBeTruthy();
    });

    it('lists, once reopened, what closed with it for the chat', () => {
      show(task({ id: 'r', reopenedWith: [{ id: 'd1', type: 'decision', title: 'use-postgres' }] }));
      expect(screen.getByText('Closed with it, not back yet')).toBeTruthy();
      expect(screen.getByText(/decision · use postgres/i)).toBeTruthy();
    });
  });
});
