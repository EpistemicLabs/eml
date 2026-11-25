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
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, owner: 'lasse', ...patch,
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
        <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} />
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
          <TaskPanel task={t} board={{ ...board(parent), viewer, closed: [] }} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={onReopen} onContinue={onContinue} />
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
            onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} />
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
      const onEndSchedule = vi.fn();
      render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={onReview} onDrop={onDrop} onEndSchedule={onEndSchedule} onReopen={() => {}} onContinue={async () => true} />
        </QueryClientProvider></MemoryRouter>,
      );
      return { onReview, onDrop, onEndSchedule };
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

    it('has only End schedule and close while its schedule is on, in review and with a paused job too', () => {
      const next = new Date(NOW + DAY_MS).toISOString();
      const { onReview, onDrop, onEndSchedule } = show(task({ id: 's', turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', nextRunAt: next, hasSchedule: true }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['End schedule and close']);
      expect(screen.getByText('No more runs. The task closes as done.')).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: 'End schedule and close' }));
      expect(onEndSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 's' }));
      expect(onReview).not.toHaveBeenCalled();
      expect(onDrop).not.toHaveBeenCalled();
      cleanup();
      show(task({ id: 'sr', turn: 'review', group: undefined, delegate: 'atlas', nextRunAt: next, hasSchedule: true }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['End schedule and close']);
      cleanup();
      // Its job is paused: no next run, and still only its schedule's end closes it.
      show(task({ id: 'sp', delegate: 'atlas', nextRunAt: null, hasSchedule: true }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['End schedule and close']);
      cleanup();
      // A next run the host does not count (a schedule left by a job that ended): it closes like any task.
      show(task({ id: 'sl', delegate: 'atlas', nextRunAt: next }));
      fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Done', 'Not needed']);
    });
  });

  describe('Looks good', () => {
    const show = (t: BoardTask) => {
      const onReview = vi.fn();
      render(
        <MemoryRouter><QueryClientProvider client={client}>
          <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={onReview} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} />
        </QueryClientProvider></MemoryRouter>,
      );
      return onReview;
    };
    const inReview = (patch: Partial<BoardTask>) => task({ id: 'r', turn: 'review', group: undefined, delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'review', why: 'Review: done' }, ...patch });

    it('reads Looks good, done on a task without a schedule', () => {
      const onReview = show(inReview({}));
      const button = screen.getByRole('button', { name: 'Looks good, done' });
      expect(button.getAttribute('title')).toBeNull();
      fireEvent.click(button);
      expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }));
    });

    it('reads Looks good while its schedule is on, also without a next run, and says the task stays open', () => {
      const onReview = show(inReview({ hasSchedule: true }));
      expect(screen.queryByRole('button', { name: 'Looks good, done' })).toBeNull();
      const button = screen.getByRole('button', { name: 'Looks good' });
      expect(button.getAttribute('title')).toBe('Approves this run. The task stays open until its schedule ends.');
      fireEvent.click(button);
      expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }));
    });
  });
});

describe('the task panel on the task state model (v0.23)', () => {
  const show = (t: BoardTask, handlers: { onHandOver?: () => void; onPark?: (task: BoardTask, until: string) => void } = {}) => render(
    <MemoryRouter><QueryClientProvider client={client}>
      <TaskPanel task={t} board={board(t)} now={NOW} sessions={[]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={handlers.onHandOver ?? (() => {})} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} onPark={handlers.onPark} />
    </QueryClientProvider></MemoryRouter>,
  );

  it('shows another member\'s session as a tab named by its state and cockpit; the question is one short Waiting on line', () => {
    show(task({ group: 'asked', delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'question', why: 'Which address? · Which tone? · One job or several?' }, runs: [
      { id: 'b', member: 'dominik', agent: 'motti', state: 'stale', lastActivityAt: new Date(NOW - 2 * 3_600_000).toISOString(), here: false },
    ] }));
    expect(screen.getByLabelText('Sessions on it').textContent).toBe("Motti · silent · Dominik's cockpit");
    expect(screen.getByText('You · 3 questions from Atlas')).toBeTruthy();
    // asked, with its session gone: no Run/Schedule row, but a way to answer
    expect(screen.queryByRole('button', { name: 'Schedule…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Work on it now' })).toBeTruthy();
  });

  it('orders its own session tabs by attention: the one the task waits on first, named needs input', () => {
    const session = (id: string, minutesAgo: number) => ({ id, spaceId: 'main', __projectId: 'bp-acme', state: 'ended', summary: id, createdAt: new Date(NOW - 3_600_000).toISOString(), lastActivity: new Date(NOW - minutesAgo * 60_000).toISOString(), readAt: null, resultAt: null, attention: null }) as never;
    render(
      <MemoryRouter><QueryClientProvider client={client}>
        <TaskPanel task={task({ group: 'asked', delegate: 'atlas', sessionIds: ['newer', 'asking'], waitingOn: { who: 'lasse', kind: 'question', why: 'Go?', session_id: 'asking' } })}
          board={board(parent)} now={NOW} sessions={[session('newer', 1), session('asking', 30)]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} />
      </QueryClientProvider></MemoryRouter>,
    );
    expect([...screen.getByLabelText('Sessions on it').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Atlas · needs input', 'Atlas · idle']);
  });

  it('folds the earlier sessions: its own reopen their chat, another member\'s is a row', () => {
    const at = new Date(NOW - DAY_MS).toISOString();
    const put = { id: 'old', spaceId: 'main', __projectId: 'bp-acme', state: 'ended', summary: 'old', createdAt: at, lastActivity: at, readAt: null, resultAt: null, attention: null, archivedAt: at } as never;
    render(
      <MemoryRouter><QueryClientProvider client={client}>
        <TaskPanel task={task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', earlierRuns: [
          { id: 'old', member: 'lasse', agent: 'atlas', startedAt: at, endedAt: at, endReason: 'finished', result: '4 mails need you', here: true },
          { id: 'theirs', member: 'dominik', agent: 'motti', startedAt: at, endedAt: at, endReason: 'finished', result: null, here: false },
        ] })} board={board(parent)} now={NOW} sessions={[put]} spaces={[]} onClose={() => {}} onOpenTask={() => {}} onHandOver={() => {}} onReview={() => {}} onDrop={() => {}} onEndSchedule={() => {}} onReopen={() => {}} onContinue={async () => true} />
      </QueryClientProvider></MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /2 earlier sessions/ }));
    const list = screen.getByLabelText('Earlier sessions');
    expect(list.textContent).toContain("Motti · ");
    expect(list.textContent).toContain("on Dominik's cockpit");
    fireEvent.click(screen.getByRole('button', { name: /Atlas · .* · finished · 4 mails need you/ }));
    expect(screen.getByTestId('session-chat')).toBeTruthy();
  });

  it('offers what the state calls for: a scheduled task has no Schedule…, a review only Looks good', () => {
    show(task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', nextRunAt: new Date(NOW + DAY_MS).toISOString(), schedule: { cron: '0 8 * * 1-5' } }));
    expect(screen.queryByRole('button', { name: 'Schedule…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run Atlas now' })).toBeTruthy();
    expect(screen.getByText('repeats on weekdays at 08:00')).toBeTruthy();
    cleanup();
    show(task({ turn: 'review', group: undefined, delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'review', why: 'Review: done' } }));
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toContain('Looks good, done');
    expect(screen.queryByRole('button', { name: 'Run Atlas now' })).toBeNull();
  });

  it('says a mission works until its goal, offers Change schedule and Park for the viewer\'s wait', () => {
    const onHandOver = vi.fn();
    const onPark = vi.fn();
    show(task({ turn: 'agent_scheduled', group: 'mission', delegate: 'atlas', goal: 'Orders sync both ways', nextRunAt: new Date(NOW + DAY_MS).toISOString(),
      waitingOn: { who: 'lasse', kind: 'question', why: 'Which warehouse?', since: new Date(NOW - 60_000).toISOString() } }), { onHandOver, onPark });
    expect(screen.getByText('until the goal is reached')).toBeTruthy();
    expect(screen.getByText(/^· next check /)).toBeTruthy();
    // the goal sits under the title
    expect(screen.getByLabelText('Goal').textContent).toBe('GoalOrders sync both ways');
    expect(screen.getByText(/You · Which warehouse\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change schedule…' }));
    expect(onHandOver).toHaveBeenCalledWith(expect.objectContaining({ id: 't' }), 'schedule');
    expect(screen.getByRole('button', { name: /Park this task's wait/ })).toBeTruthy();
  });
});
