// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { BoardTask, ScheduleAction, TaskRecord, TaskRecordView, TaskRun } from '@/lib/task-board';
import { setTimeZoneForTest } from '@/lib/time-zone';

import { ScheduleSection } from './ScheduleSection';

// The task holds its schedule: its times, one Pause and one End, and what this cockpit keeps for it.

const NOW = Date.parse('2026-11-19T03:35:00Z'); // Thu 19 Nov 2026, 10:35 in Bangkok
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 7, minute)).toISOString();
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 'daily', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'daily-brief', status: 'active', parentId: null, updatedAt: null,
  turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', coverage: { ok: true, how: 'at_time' }, urgency: 0, important: false, sessionIds: [], working: false,
  nextRunAt: at(20, 8), hasSchedule: true, owner: 'member', schedule: { crons: ['0 8 * * 1-5', '0 18,22 * * 1-5'], time_zone: 'Asia/Bangkok' }, ...patch,
});
const record = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ id: 'daily', triggers: [], reply: {}, pausedReason: null, ...patch });
const run = (patch: Partial<TaskRun>): TaskRun => ({ id: 'r1', number: 1, trigger: 'schedule', dueAt: at(19, 8), status: 'finished', sessionId: 's1', startedAt: at(19, 8, 1), finishedAt: at(19, 8, 9), outcome: 'done', note: null, session: null, ...patch });

/** Renders the section; the record route answers `view` (none: this cockpit keeps nothing). */
function show(t: BoardTask, view: Partial<TaskRecordView> = {}, ok = true, viewer?: string) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ record: null, runs: [], held: false, running: false, ...view }), { status: 200 });
  }));
  const onAct = vi.fn(async (_task: BoardTask, _action: ScheduleAction) => ok);
  const onEndSchedule = vi.fn();
  const onAddTime = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ScheduleSection task={t} now={NOW} viewer={viewer} onAct={onAct} onEndSchedule={onEndSchedule} onAddTime={onAddTime} /></QueryClientProvider>);
  return { onAct, onEndSchedule, onAddTime, asked };
}
const section = () => within(screen.getByRole('region', { name: 'Schedule' }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTimeZoneForTest(null); });

describe('the schedule section of a task', () => {
  it('lists the repeating times in words, each with Remove, and the next run', () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task());
    const times = within(section().getByRole('list', { name: 'Repeating times' })).getAllByRole('listitem');
    expect(times.map((li) => li.textContent)).toEqual(['On weekdays at 08:00Remove', 'On weekdays at 18:00 and 22:00Remove']);
    expect(section().getByRole('button', { name: 'Remove the time: On weekdays at 08:00' })).toBeTruthy();
    expect(section().getByText('Next run tomorrow 08:00')).toBeTruthy();
    // its zone is the user's: not named
    expect(section().queryByText(/^Times in /)).toBeNull();
    expect(section().queryByLabelText('Wake-up')).toBeNull();
  });

  it('says how many runs are left when the schedule ends after a number of runs (counted over the record\'s life)', async () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task(), { record: record({ runCount: 4, end: { afterRuns: 7 } }) });
    expect(await section().findByText('3 more runs, then the schedule ends.')).toBeTruthy();
    cleanup();
    show(task(), { record: record({ runCount: 6, end: { afterRuns: 7 } }) });
    expect(await section().findByText('1 more run, then the schedule ends.')).toBeTruthy();
    cleanup();
    // no such end: nothing is said
    show(task(), { record: record({ runCount: 6, end: null, limited: true }) });
    await section().findByText('On this cockpit');
    expect(section().queryByText(/more run/)).toBeNull();
  });

  it('names the zone the times are read in when it is not the user\'s, and shows a rule the words do not fit as itself', () => {
    setTimeZoneForTest('Europe/Berlin');
    show(task({ schedule: { crons: ['*/20 * * * *'], time_zone: 'Asia/Bangkok' } }));
    expect(section().getByText('*/20 * * * *')).toBeTruthy();
    expect(section().getByText('Times in Asia/Bangkok.')).toBeTruthy();
  });

  it('shows the wake-up with its reason, and a run whose time has come as due', () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task({ group: 'mission', nextRunAt: at(19, 10, 27), schedule: { at: at(19, 10, 27), why: 'Check whether the supplier answered.', by_session: 's1' } }));
    expect(section().getByLabelText('Wake-up').textContent).toBe('Wake-up 10:27RescheduleRemoveCheck whether the supplier answered.');
    expect(section().getByText('Run due since 10:27')).toBeTruthy();
    expect(section().queryByRole('list', { name: 'Repeating times' })).toBeNull();
  });

  it('says who the wake-up is for: the agent checks back, or a reminder for the viewer', () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task({ group: 'mission', schedule: { at: at(20, 9), why: 'Did Acme answer?', by: 'nova' } }), {}, true, 'dev-user');
    expect(section().getByLabelText('Wake-up').textContent).toBe('Nova checks back tomorrow 09:00RescheduleRemoveDid Acme answer?');
    cleanup();
    show(task({ group: 'mission', schedule: { at: at(20, 9), why: 'Call the bank', by: 'dev-user' } }), {}, true, 'dev-user');
    expect(section().getByLabelText('Wake-up').textContent).toBe('Reminder for you tomorrow 09:00RescheduleRemoveCall the bank');
  });

  it('removes the wake-up at once', async () => {
    const { onAct } = show(task({ schedule: { at: at(20, 9), by: 'nova' } }), {}, true, 'dev-user');
    fireEvent.click(section().getByRole('button', { name: 'Remove the wake-up' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }), { kind: 'remove_wake' }));
  });

  it('reschedules the wake-up to a date and time read in the user\'s zone, only to a time still to come', async () => {
    setTimeZoneForTest('Asia/Bangkok');
    const { onAct } = show(task({ schedule: { at: at(20, 9), by: 'nova' } }), {}, true, 'dev-user');
    fireEvent.click(section().getByRole('button', { name: 'Reschedule the wake-up' }));
    const form = within(section().getByRole('group', { name: 'Reschedule the wake-up' }));
    // It starts at the wake-up's own time, in the user's zone.
    expect((form.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-20');
    expect((form.getByLabelText('Time') as HTMLInputElement).value).toBe('09:00');
    expect(form.getByText('Asia/Bangkok')).toBeTruthy();
    // A time that has passed cannot be saved.
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '2026-11-18' } });
    expect((form.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '2026-11-23' } });
    fireEvent.change(form.getByLabelText('Time'), { target: { value: '14:30' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }), { kind: 'reschedule_wake', at: '2026-11-23T07:30:00.000Z' }));
  });

  it('Cancel leaves the wake-up as it is', () => {
    const { onAct } = show(task({ schedule: { at: at(20, 9), by: 'nova' } }), {}, true, 'dev-user');
    fireEvent.click(section().getByRole('button', { name: 'Reschedule the wake-up' }));
    fireEvent.click(within(section().getByRole('group', { name: 'Reschedule the wake-up' })).getByRole('button', { name: 'Cancel' }));
    expect(section().queryByRole('group', { name: 'Reschedule the wake-up' })).toBeNull();
    expect(onAct).not.toHaveBeenCalled();
  });

  it('removes one of several times at once', async () => {
    const { onAct } = show(task());
    fireEvent.click(section().getByRole('button', { name: 'Remove the time: On weekdays at 08:00' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }), { kind: 'remove_time', cron: '0 8 * * 1-5' }));
  });

  it('says that removing the only time ends the schedule, and asks before it does', async () => {
    const { onAct } = show(task({ schedule: { crons: ['0 8 * * 1-5'] } }));
    fireEvent.click(section().getByRole('button', { name: 'Remove the time: On weekdays at 08:00' }));
    expect(onAct).not.toHaveBeenCalled();
    expect(section().getByText('This is its only time: removing it ends the schedule. The task stays open.')).toBeTruthy();
    fireEvent.click(section().getByRole('button', { name: 'Cancel' }));
    expect(section().queryByText(/removing it ends the schedule/)).toBeNull();
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(section().getByRole('button', { name: 'Remove the time: On weekdays at 08:00' }));
    fireEvent.click(section().getByRole('button', { name: 'Remove and end schedule' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }), { kind: 'remove_time', cron: '0 8 * * 1-5' }));
  });

  it('removes the only repeating time at once when a wake-up keeps the schedule', async () => {
    const { onAct } = show(task({ schedule: { crons: ['0 8 * * 1-5'], at: at(23, 9) } }));
    fireEvent.click(section().getByRole('button', { name: 'Remove the time: On weekdays at 08:00' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledTimes(1));
  });

  it('has one Pause, Run now and End for the whole schedule, and Add a time', async () => {
    const { onAct, onEndSchedule, onAddTime } = show(task());
    expect(section().queryByRole('button', { name: 'Resume' })).toBeNull();
    fireEvent.click(section().getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(onAct).toHaveBeenLastCalledWith(expect.anything(), { kind: 'pause' }));
    await waitFor(() => expect((section().getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(section().getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(onAct).toHaveBeenLastCalledWith(expect.anything(), { kind: 'run_now' }));
    fireEvent.click(section().getByRole('button', { name: 'End schedule and close' }));
    expect(onEndSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }));
    fireEvent.click(section().getByRole('button', { name: 'Add a time…' }));
    expect(onAddTime).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily' }));
    // nothing here can be undone, so nothing offers it
    expect(section().queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a paused schedule says so and offers Resume; a pause the cockpit made says why', async () => {
    const { onAct } = show(task({ nextRunAt: null, schedule: { crons: ['0 8 * * 1-5'], paused: true } }));
    expect(section().getByText('paused')).toBeTruthy();
    expect(section().getByText('Paused: nothing runs until you resume it.')).toBeTruthy();
    expect(section().queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(section().getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.anything(), { kind: 'resume' }));
    cleanup();
    show(task({ nextRunAt: null, schedule: { crons: ['0 8 * * 1-5'], paused: true } }), { record: record({ pausedReason: '3 runs in a row failed' }) });
    expect(await screen.findByText('Paused by the cockpit: 3 runs in a row failed')).toBeTruthy();
  });

  it('says when the schedule ends, and that nothing runs once its end has passed', () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task({ schedule: { crons: ['0 8 * * 1-5'], ends_at: at(30, 9) } }));
    expect(section().getByText('Next run tomorrow 08:00 · ends 30 Nov 09:00')).toBeTruthy();
    cleanup();
    show(task({ nextRunAt: null, schedule: { crons: ['0 8 * * 1-5'], ends_at: at(18, 9) } }));
    expect(section().getByText('Its end has passed (yesterday 09:00): nothing runs any more.')).toBeTruthy();
  });

  it('past its end the repeating times have ended, and a wake-up that is still set runs at its time', () => {
    setTimeZoneForTest('Asia/Bangkok');
    show(task({ nextRunAt: at(23, 9), schedule: { crons: ['0 8 * * 1-5'], at: at(23, 9), why: 'Check the answer', ends_at: at(18, 9) } }));
    expect(section().queryByText(/nothing runs any more/)).toBeNull();
    expect(section().getByText('Its end has passed (yesterday 09:00): the repeating times no longer run, the wake-up still does. Next run Mon 09:00')).toBeTruthy();
    cleanup();
    // the wake-up's time has come and it has not started yet
    show(task({ nextRunAt: at(19, 9), schedule: { crons: ['0 8 * * 1-5'], at: at(19, 9), ends_at: at(18, 9) } }));
    expect(section().getByText('Its end has passed (yesterday 09:00): the repeating times no longer run, the wake-up still does. Run due since 09:00')).toBeTruthy();
    cleanup();
    // an end on a schedule without a repeating time ends nothing
    show(task({ nextRunAt: at(23, 9), schedule: { at: at(23, 9), ends_at: at(18, 9) } }));
    expect(section().getByText('Next run Mon 09:00')).toBeTruthy();
  });

  it('asks this cockpit for the task\'s record in its space; the newest run reads without opening the fold, four more inside', async () => {
    setTimeZoneForTest('Asia/Bangkok');
    const runs = [
      run({ id: 'r7', status: 'skipped', number: 0, startedAt: null, finishedAt: null, sessionId: null, outcome: null, dueAt: at(19, 10), note: 'a session of the task was working' }),
      run({ id: 'r6', outcome: 'failed' }), run({ id: 'r5' }), run({ id: 'r4' }), run({ id: 'r3' }), run({ id: 'r2' }),
    ];
    const { asked } = show(task(), { record: record(), runs });
    const list = await screen.findByRole('list', { name: 'Earlier runs', hidden: true });
    expect(asked[0]).toBe('/api/v1/tasks/daily/record?spaceId=main');
    expect(section().getByText('10:00 · skipped · a session of the task was working')).toBeTruthy();
    const lines = within(list).getAllByRole('listitem', { hidden: true }).map((li) => li.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('08:01 · failed');
    expect(within(list).getAllByRole('listitem', { hidden: true })[0].className).toContain('text-stopped-ink');
    // a record that only counts runs shows no settings
    expect(section().queryByLabelText('On this cockpit')).toBeNull();
  });

  describe('what this cockpit keeps for it', () => {
    it('shows addresses waiting for the user\'s OK first and clearly, and approves them', async () => {
      const { onAct } = show(task(), { record: record({ triggers: [{ type: 'mail' }], pendingApproval: true }) });
      const waiting = within(await screen.findByRole('group', { name: 'Waiting for your OK' }));
      expect(section().getByText('waiting for your OK')).toBeTruthy();
      expect(waiting.getByText('This task wants to be woken by mail.')).toBeTruthy();
      fireEvent.click(waiting.getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.anything(), { kind: 'record', change: { kind: 'approve' } }));
    });

    it('a channel drafts its replies until the user lets it send, asked twice; back to drafts at once', async () => {
      const { onAct } = show(task(), { record: record({ triggers: [{ type: 'mail' }] }) });
      const settings = within(await screen.findByLabelText('On this cockpit'));
      expect(settings.getByText('drafts you approve')).toBeTruthy();
      fireEvent.click(settings.getByRole('button', { name: 'Let it send…' }));
      expect(onAct).not.toHaveBeenCalled();
      expect(settings.getByText('Its mail replies go out without you reading them first.')).toBeTruthy();
      fireEvent.click(settings.getByRole('button', { name: 'Send without asking' }));
      await waitFor(() => expect(onAct).toHaveBeenCalledWith(expect.anything(), { kind: 'record', change: { kind: 'reply', channel: 'mail', mode: 'send' } }));
      cleanup();
      const again = show(task(), { record: record({ triggers: [{ type: 'mail' }], reply: { mail: 'send' } }) });
      const sends = within(await screen.findByLabelText('On this cockpit'));
      expect(sends.getByText('sent without asking')).toBeTruthy();
      fireEvent.click(sends.getByRole('button', { name: 'Back to drafts' }));
      await waitFor(() => expect(again.onAct).toHaveBeenCalledWith(expect.anything(), { kind: 'record', change: { kind: 'reply', channel: 'mail', mode: 'draft' } }));
      // not limited, but the record shows: it can be limited from here
      expect(sends.getByRole('button', { name: 'Limit it' })).toBeTruthy();
    });

    it('a limited task lends Chrome or Messages for an hour, takes them back, and asks before its limits go', async () => {
      setTimeZoneForTest('Asia/Bangkok');
      const { onAct } = show(task(), { record: record({ limited: true, grants: [{ tool: 'chrome', until: at(19, 11, 30), reason: null }, { tool: 'SendMessage', until: at(19, 9), reason: null }] }) });
      const settings = within(await screen.findByLabelText('On this cockpit'));
      expect(settings.getByText(/no shell, no messages to sessions, only the brain/)).toBeTruthy();
      expect(settings.getByText(/lent until 11:30/)).toBeTruthy();
      fireEvent.click(settings.getByRole('button', { name: 'Take Chrome back' }));
      await waitFor(() => expect(onAct).toHaveBeenLastCalledWith(expect.anything(), { kind: 'record', change: { kind: 'revoke', tool: 'chrome' } }));
      // the Messages grant is over: it can be lent again
      await waitFor(() => expect((settings.getByRole('button', { name: 'Lend Messages for 1 h' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(settings.getByRole('button', { name: 'Lend Messages for 1 h' }));
      await waitFor(() => expect(onAct).toHaveBeenLastCalledWith(expect.anything(), { kind: 'record', change: { kind: 'grant', tool: 'SendMessage' } }));
      await waitFor(() => expect((settings.getByRole('button', { name: 'Remove limits…' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(settings.getByRole('button', { name: 'Remove limits…' }));
      expect(onAct).toHaveBeenCalledTimes(2);
      fireEvent.click(settings.getByRole('button', { name: 'Remove limits' }));
      await waitFor(() => expect(onAct).toHaveBeenLastCalledWith(expect.anything(), { kind: 'record', change: { kind: 'limited', limited: false } }));
    });

    it('a task without a schedule shows the section only for a record with something to show, without Pause or End', async () => {
      show(task({ hasSchedule: false, schedule: undefined, nextRunAt: null, turn: 'needs_you', group: 'own' }), { record: record() });
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
      expect(screen.queryByRole('region', { name: 'Schedule' })).toBeNull();
      cleanup();
      show(task({ hasSchedule: false, schedule: undefined, nextRunAt: null, turn: 'needs_you', group: 'own' }), { record: record({ triggers: [{ type: 'mail' }] }) });
      await screen.findByLabelText('On this cockpit');
      expect(section().getByRole('button', { name: 'Run now' })).toBeTruthy();
      expect(section().queryByRole('button', { name: 'Pause' })).toBeNull();
      expect(section().queryByRole('button', { name: 'End schedule and close' })).toBeNull();
      expect(section().queryByRole('button', { name: 'Add a time…' })).toBeNull();
    });
  });
});
