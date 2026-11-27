// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BoardTask } from '@/lib/task-board';
import { setTimeZoneForTest } from '@/lib/time-zone';

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
afterEach(() => { cleanup(); setTimeZoneForTest(null); });

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
    expect(screen.getByText(/starts in a new session \(its session runs in the terminal fallback\)/)).toBeTruthy();
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

describe('scheduling a hand-over', () => {
  // The tests run in UTC. Thu 19 Nov 2026 22:00 UTC is Fri 20 Nov 05:00 in Bangkok.
  const LATE = Date.parse('2026-11-19T22:00:00Z');
  const schedule = () => {
    const onSubmit = vi.fn();
    render(<HandOverDialog task={task()} mode="schedule" agents={['atlas']} desks={[]} now={LATE} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
    return onSubmit;
  };

  it('reads its times in the user\'s time zone (Settings), not the browser\'s', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const onSubmit = schedule();
    // Tomorrow is Saturday in Bangkok, though it is still Thursday in UTC.
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ at: '2026-11-21T09:00', timeZone: 'Asia/Bangkok' });
  });

  it('fills the picker with the user\'s date and names the zone next to it', () => {
    setTimeZoneForTest('Asia/Makassar');
    const onSubmit = schedule();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date…' }));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-21');
    expect((screen.getByLabelText('Date') as HTMLInputElement).min).toBe('2026-11-20');
    expect(screen.getByText('Asia/Makassar')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '20:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ at: '2026-11-21T20:15', timeZone: 'Asia/Makassar' });
  });

  it('one time is the task\'s wake-up and Repeat one more repeating time; how a run goes on is not asked', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const onSubmit = schedule();
    expect(screen.getByText(/Atlas is woken on this task at that time\. Until then/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat…' }));
    // The model decides it: a repeating time starts a new session, a wake-up continues.
    expect(screen.queryByText('Each run')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continues the same session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Starts a new session' })).toBeNull();
    expect(screen.getByText(/on that rhythm until you end it, each time in a new session\. The task sits/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'mondays' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0]).toEqual({ mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { cron: '0 9 * * 1', timeZone: 'Asia/Bangkok' } });
    // The host reads a time and its zone only: there is no "until the goal is reached" to choose.
    expect(screen.queryByRole('button', { name: 'Until the goal is reached' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Once' }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[1][0].schedule).toEqual({ at: '2026-11-21T09:00', timeZone: 'Asia/Bangkok' });
  });

  it('says what it does to the schedule the task has: a new wake-up replaces the one set, a repeating time is added', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const has = task({ delegate: 'atlas', hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'], at: '2026-11-23T02:00:00.000Z' } });
    render(<HandOverDialog task={has} mode="schedule" agents={['atlas']} desks={[]} now={LATE} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText(/It replaces the wake-up set for Mon 09:00\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat…' }));
    expect(screen.getByText(/The time is added to those the task repeats at\. The task sits/)).toBeTruthy();
    cleanup();
  });

  it('reads one more repeating time in the zone of the task\'s repeating times and says so; a wake-up stays in the user\'s', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const onSubmit = vi.fn();
    const elsewhere = task({ delegate: 'atlas', hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' } });
    render(<HandOverDialog task={elsewhere} mode="schedule" agents={['atlas']} desks={[]} now={LATE} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
    // Once: an instant, read where the user reads every time. Nothing about the task's zone.
    expect(screen.queryByText(/Times of this task are in/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ at: '2026-11-21T09:00', timeZone: 'Asia/Bangkok' });
    // Repeat: 09:00 is 09:00 in Berlin, the zone the host would refuse any other for.
    fireEvent.click(screen.getByRole('button', { name: 'Repeat…' }));
    expect(screen.getByText('Times of this task are in Europe/Berlin.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[1][0].schedule).toEqual({ cron: '0 9 * * 1-5', timeZone: 'Europe/Berlin' });
    // A picked time is read there too, and the field names that zone.
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date…' }));
    expect(screen.getByText('Europe/Berlin')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '20:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[2][0].schedule).toEqual({ cron: '15 20 * * 1-5', timeZone: 'Europe/Berlin' });
  });

  it('reads a repeating time in the user\'s zone on a task that has none yet (also one with only a wake-up)', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const onSubmit = vi.fn();
    const wakeOnly = task({ delegate: 'atlas', hasSchedule: true, schedule: { at: '2026-11-23T02:00:00.000Z', time_zone: 'Europe/Berlin' } });
    render(<HandOverDialog task={wakeOnly} mode="schedule" agents={['atlas']} desks={[]} now={LATE} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Repeat…' }));
    expect(screen.queryByText(/Times of this task are in/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ cron: '0 9 * * 1-5', timeZone: 'Asia/Bangkok' });
  });
});
