// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { Board, BoardTask, InboxItem } from '@/lib/task-board';
import { setTimeZoneForTest } from '@/lib/time-zone';
import { resetTaskBoardPage } from '@/stores/useTaskBoardPageStore';

import { InboxView, type InboxAction, type UnreadProps } from './InboxView';

// The owner's move and the agent's check-back stand side by side.

const NOW = Date.parse('2026-11-19T10:35:00Z'); // Thu 19 Nov 2026, 10:35 UTC
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString();
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 'offer', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'acme-offer', status: 'active', parentId: null, updatedAt: at(19, 9),
  turn: 'needs_you', group: 'asked', coverage: { ok: false, group: 'ask' }, urgency: 0, important: false, sessionIds: ['s1'], working: false, nextRunAt: null, hasSchedule: false,
  owner: 'dev-user', delegate: 'nova', ...patch,
});
const item = (patch: Partial<InboxItem> = {}): InboxItem => ({
  key: 'task:offer@x', kind: 'do', space: 'main', title: 'acme-offer', text: 'Send the signed offer to Acme', since: at(19, 9), taskId: 'offer', sessionId: 's1', waitId: 's1', ...patch,
});
const board = (items: InboxItem[], tasks: BoardTask[] = [task()]): Board => ({
  at: new Date(NOW).toISOString(), viewer: 'dev-user', spaces: [{ id: 'main', name: 'Main', agents: ['nova'] }], projects: [{ spaceId: 'main', id: 'acme', name: 'Acme', goal: null }],
  tasks, inbox: items, snoozed: [], events: [], counts: { needsYou: items.length, inbox: items.length },
});
const unread: UnreadProps = { sessions: [], spaces: [], open: false, onToggle: () => {}, onOpen: () => {}, onMarkAllRead: () => {} };

function show(b: Board) {
  const onOpen = vi.fn<(i: InboxItem) => void>();
  const onAction = vi.fn<(a: InboxAction) => void>();
  render(<InboxView board={b} now={NOW} compact={false} currentTaskId={null} unread={unread} onOpen={onOpen} onAction={onAction} />);
  return { onOpen, onAction };
}
const row = (text: string) => screen.getByText(text).closest('button')!.parentElement!;

beforeEach(() => { setTimeZoneForTest('UTC'); resetTaskBoardPage(); });
afterEach(() => { cleanup(); setTimeZoneForTest(null); });

describe('a step that is the viewer\'s to take (do)', () => {
  it('reads Your move, offers Done and Open chat besides parking, and Done names its wait', () => {
    const { onAction, onOpen } = show(board([item()]));
    const r = within(row('Send the signed offer to Acme'));
    expect(r.getByText('Your move')).toBeTruthy();
    expect(r.queryByRole('button', { name: /Looks good/ })).toBeNull();
    fireEvent.click(r.getByRole('button', { name: 'Done' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'done', item: expect.objectContaining({ waitId: 's1', taskId: 'offer' }) });
    fireEvent.click(r.getByRole('button', { name: 'Open chat' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'task:offer@x' }));
    expect(r.getByRole('button', { name: 'Park until tomorrow' })).toBeTruthy();
  });

  it('has no Done without the wait\'s id (an older host): it opens the chat instead', () => {
    show(board([item({ waitId: undefined })]));
    const r = within(row('Send the signed offer to Acme'));
    expect(r.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(r.getByRole('button', { name: 'Open chat' })).toBeTruthy();
  });

  it('says when it is due: today, overdue, or the date', () => {
    show(board([
      item({ key: 'a', text: 'Today step', due: '2026-11-19' }),
      item({ key: 'b', text: 'Late step', due: '2026-11-17' }),
      item({ key: 'c', text: 'Later step', due: '2026-12-02' }),
      item({ key: 'd', text: 'Timed step', due: at(19, 17) }),
    ]));
    expect(within(row('Today step')).getByText('due today')).toBeTruthy();
    expect(within(row('Late step')).getByText('overdue')).toBeTruthy();
    expect(within(row('Later step')).getByText('due 2 Dec')).toBeTruthy();
    expect(within(row('Timed step')).getByText('due today 17:00')).toBeTruthy();
  });
});

describe('the check-back under an item', () => {
  it('names the agent and the time under any item of a task with a wake-up', () => {
    show(board([
      item({ checkBack: { at: at(20, 9), by: 'nova' } }),
      item({ key: 'q', kind: 'question', text: 'Which warehouse?', checkBack: { at: at(19, 15), by: 'nova' } }),
    ]));
    expect(within(row('Send the signed offer to Acme')).getByText('Nova checks back tomorrow 09:00')).toBeTruthy();
    expect(within(row('Which warehouse?')).getByText('Nova checks back 15:00')).toBeTruthy();
  });

  it('reads Reminder when the wake-up is the viewer\'s own', () => {
    show(board([item({ checkBack: { at: at(20, 9), by: 'dev-user' } })]));
    expect(within(row('Send the signed offer to Acme')).getByText('Reminder tomorrow 09:00')).toBeTruthy();
  });

  it('shows no clock line on an item of a task without a wake-up', () => {
    show(board([item()]));
    expect(within(row('Send the signed offer to Acme')).queryByText(/checks back|Reminder/)).toBeNull();
  });
});

describe('Looks good on a review', () => {
  const review = (patch: Partial<InboxItem> = {}) => item({ key: 'r', kind: 'review', text: 'Draft is ready', ...patch });

  it('says that it closes the task and ends the agent\'s check when the task does not repeat', () => {
    const { onAction } = show(board([review({ checkBack: { at: at(20, 9), by: 'nova' } })], [task({ turn: 'review', group: undefined, hasSchedule: true, schedule: { at: at(20, 9), by: 'nova' } })]));
    const button = within(row('Draft is ready')).getByRole('button', { name: 'Looks good · closes the task, ends Nova\'s check' });
    expect(button.getAttribute('title')).toBeNull();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ kind: 'review', item: expect.objectContaining({ key: 'r' }) });
  });

  it('reads Looks good on a task with repeating times, and on one without a wake-up', () => {
    show(board([review({ checkBack: { at: at(20, 9), by: 'nova' }, repeating: true })], [task({ turn: 'review', group: undefined, hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'], at: at(20, 9), by: 'nova' } })]));
    const button = within(row('Draft is ready')).getByRole('button', { name: 'Looks good' });
    expect(button.getAttribute('title')).toBe('Approves this run. The task stays open until its schedule ends.');
    cleanup();
    show(board([review()]));
    expect(within(row('Draft is ready')).getByRole('button', { name: 'Looks good' }).getAttribute('title')).toBeNull();
  });
});
