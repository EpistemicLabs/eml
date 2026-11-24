// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import type { Board, BoardTask } from '@/lib/task-board';
import { DAY_MS } from '@/lib/time';

// The journal shows or hides with its engram's load; that is what moved the Related block's copies in.
const live = vi.hoisted(() => ({ engram: undefined as unknown }));
vi.mock('@/lib/queries', () => ({ useEngram: () => ({ data: live.engram }) }));
vi.mock('@/components/task-sections', () => ({ TaskJournal: () => <div>journal</div> }));
vi.mock('@/components/ui/session-chat', () => ({ SessionChat: ({ composer }: { composer?: React.ReactNode }) => <div data-testid="session-chat">{composer}</div> }));

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
        <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onReopen={() => {}} onContinue={async () => true} />
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
    const show = (t: BoardTask, onReopen = vi.fn(), viewer = 'lasse', onContinue = vi.fn(async () => true)) => {
      render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={t} board={{ ...board(parent), viewer, closed: [] }} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onReopen={onReopen} onContinue={onContinue} />
        </QueryClientProvider></MemoryRouter>,
      );
      return onReopen;
    };
    const input = () => screen.getByRole('textbox', { name: /Continue…|What should the follow-up do/ });

    it('keeps an input under its chat: Enter reopens with the message, ⌥Enter starts a follow-up', async () => {
      const onContinue = vi.fn(async () => true);
      show(closed({ status: 'resolved' }), vi.fn(), 'lasse', onContinue);
      expect(input().getAttribute('placeholder')).toBe('Continue… (reopens the task)');
      fireEvent.change(input(), { target: { value: 'one more fix' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await vi.waitFor(() => expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), 'one more fix', 'reopen', expect.any(Function)));
      await vi.waitFor(() => expect((input() as HTMLTextAreaElement).value).toBe(''));
      fireEvent.change(input(), { target: { value: 'something new' } });
      fireEvent.keyDown(input(), { key: 'Enter', altKey: true });
      await vi.waitFor(() => expect(onContinue).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c' }), 'something new', 'follow_up', expect.any(Function)));
      expect(screen.getByRole('button', { name: /As follow-up/ })).toBeTruthy();
    });

    it('keeps the text when the cockpit refuses, and Shift+Enter is a new line', async () => {
      const onContinue = vi.fn(async () => false);
      show(closed({ status: 'resolved' }), vi.fn(), 'lasse', onContinue);
      fireEvent.change(input(), { target: { value: 'keep me' } });
      fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
      expect(onContinue).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
      await vi.waitFor(() => expect(onContinue).toHaveBeenCalled());
      await vi.waitFor(() => expect((input() as HTMLTextAreaElement).value).toBe('keep me'));
    });

    it('makes a follow-up the main way after 7 days, and the only one for a replaced task; none for someone else\'s', () => {
      show(closed({ status: 'resolved', closedAt: new Date(NOW - 8 * DAY_MS).toISOString() }));
      expect(screen.getByRole('button', { name: /^Start follow-up/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Reopen & send/ })).toBeTruthy();
      cleanup();
      show(closed({ blocked: 'superseded', status: 'superseded' }));
      expect(screen.getByRole('button', { name: /^Start follow-up/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Reopen & send|^Send/ })).toBeNull();
      expect(screen.getByText(/can't be reopened: a follow-up starts a new task/)).toBeTruthy();
      cleanup();
      show(closed({ owner: 'dominik' }));
      expect(screen.queryByRole('textbox', { name: /Continue…|What should the follow-up do/ })).toBeNull();
    });

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

    it('under its session\'s chat: the input for the owner; for someone else\'s task or one being reopened, a note', () => {
      const withSession = (patch: Partial<BoardTask>, viewer = 'lasse') => render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={closed({ status: 'resolved', sessionIds: ['s1'], ...patch })} board={{ ...board(parent), viewer, closed: [] }} now={NOW} spaces={[]}
            sessions={[{ id: 's1', spaceId: 'main', __projectId: 'acme', lastActivity: new Date(NOW).toISOString() } as never]}
            onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onReopen={() => {}} onContinue={async () => true} />
        </QueryClientProvider></MemoryRouter>,
      );
      withSession({});
      expect(screen.getByTestId('session-chat').querySelector('textarea')).toBeTruthy();
      cleanup();
      withSession({ owner: 'dominik' });
      expect(screen.getByTestId('session-chat').textContent).toContain('Only its owner (dominik) can go on with this task.');
      cleanup();
      withSession({ pending: { opId: 'op', kind: 'reopen', undoUntil: new Date(NOW + 8000).toISOString() } });
      expect(screen.getByTestId('session-chat').textContent).toContain('Reopening…');
    });

    it('lists, once reopened, what closed with it for the chat', () => {
      show(task({ id: 'r', reopenedWith: [{ id: 'd1', type: 'decision', title: 'use-postgres' }] }));
      expect(screen.getByText('Closed with it, not back yet')).toBeTruthy();
      expect(screen.getByText(/decision · use postgres/i)).toBeTruthy();
    });
  });

  describe('the ⋯ menu', () => {
    const show = (t: BoardTask) => {
      const onReview = vi.fn();
      const onDrop = vi.fn();
      render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={onReview} onDrop={onDrop} onReopen={() => {}} onContinue={async () => true} />
        </QueryClientProvider></MemoryRouter>,
      );
      return { onReview, onDrop };
    };

    it('closes an open task as done, or as not needed', () => {
      const { onReview, onDrop } = show(task({ id: 'o' }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }));
      expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'o' }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Not needed' }));
      expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: 'o' }));
    });

    it('has no Done in review (Looks good, done is there), and no menu on a closed task', () => {
      show(task({ id: 'r', turn: 'review' }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Done' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Not needed' })).toBeTruthy();
      cleanup();
      show(task({ id: 'c', status: 'resolved', turn: null }));
      expect(screen.queryByRole('button', { name: 'More task actions' })).toBeNull();
    });
  });
});
