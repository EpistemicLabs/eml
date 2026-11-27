import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeGrants, changeRecord, cronWords, fetchTaskRecord, isDue, isLastTime, nextRunText, pauseSchedule, recordShows, removeTime, resumeSchedule, runLine, runNow, scheduleDone, scheduleZone, timeText, type TaskRecord, type TaskRun, modeLabel, takeOver, taskMode, cardLine, cardTime, closeTask, earlierRunLine, endSchedule, isScheduled, panelActions, repeatsText, sessionState, waitingLine, columns, continueMode, coverageText, REOPEN_DAYS, statusOrTurn, dueLabel, fetchClosedTasks, focus, hueOf, inFilter, projectRows, quietProjects, readable, resolveFilter, snoozeTimes, startTaskSession, taskSessionsKey, visibleInPlan, when, type BoardTask, askDueLabel, checkBackOf, checkBackText, looksGoodLabel, markDone, removeWake, repeats, rescheduleWake } from './task-board';
import { DAY_MS } from './time';
import { setTimeZoneForTest } from './time-zone';

const NOW = new Date(2026, 10, 19, 10, 35).getTime(); // Thu 19 Nov 2026, 10:35 local
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'acme-cancellation-rescue', status: 'active', parentId: null, updatedAt: local(19, 9),
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, owner: 'lasse', ...patch,
});

describe('times', () => {
  it('says a moment the way a person does', () => {
    expect(when(local(19, 10, 27), NOW)).toBe('10:27');
    expect(when(local(20, 9), NOW)).toBe('tomorrow 09:00');
    expect(when(local(18, 22, 9), NOW)).toBe('yesterday 22:09');
    expect(when(local(23, 9), NOW)).toBe('Mon 09:00');
    expect(when(local(30, 9), NOW)).toBe('30 Nov 09:00');
    expect(when(null, NOW)).toBe('');
  });

  it('says a due date', () => {
    expect(dueLabel('2026-11-19', NOW)).toBe('today');
    expect(dueLabel('2026-11-20', NOW)).toBe('tomorrow');
    expect(dueLabel('2026-11-23', NOW)).toBe('in 4 days');
    expect(dueLabel('2026-11-18', NOW)).toBe('1 day late');
    expect(dueLabel('2027-02-15', NOW)).toBe('15 Feb');
  });

  it('snoozes to tomorrow 09:00 and next Monday 09:00', () => {
    expect(snoozeTimes(NOW)).toEqual({ tomorrow: local(20, 9), monday: local(23, 9) });
  });

  describe('in the user\'s time zone, not the browser\'s (the tests run in UTC)', () => {
    afterEach(() => setTimeZoneForTest(null));
    // Thu 19 Nov 2026 22:00 UTC is already Fri 20 Nov 05:00 in Bangkok (UTC+7).
    const LATE = Date.parse('2026-11-19T22:00:00Z');

    it('says a moment on the user\'s clock and calendar', () => {
      setTimeZoneForTest('Asia/Bangkok');
      expect(when('2026-11-19T22:30:00Z', LATE)).toBe('05:30');
      expect(when('2026-11-20T13:15:00Z', LATE)).toBe('20:15');
      expect(when('2026-11-20T20:15:00Z', LATE)).toBe('tomorrow 03:15');
      expect(when('2026-11-19T16:00:00Z', LATE)).toBe('yesterday 23:00');
      // An explicit zone wins over the setting.
      expect(when('2026-11-20T13:15:00Z', LATE, 'UTC')).toBe('tomorrow 13:15');
    });

    it('counts a due date from the user\'s today', () => {
      setTimeZoneForTest('Asia/Bangkok');
      expect(dueLabel('2026-11-20', LATE)).toBe('today');
      expect(dueLabel('2026-11-19', LATE)).toBe('1 day late');
      expect(dueLabel('2026-11-20', LATE, 'UTC')).toBe('tomorrow');
    });

    it('parks until 09:00 on the user\'s clock: tomorrow and next Monday there', () => {
      setTimeZoneForTest('Asia/Makassar');
      // Fri 20 Nov in Makassar (UTC+8): tomorrow is Sat 21, next Monday 23 Nov, each 09:00 = 01:00 UTC.
      expect(snoozeTimes(LATE)).toEqual({ tomorrow: '2026-11-21T01:00:00.000Z', monday: '2026-11-23T01:00:00.000Z' });
    });
  });
});

describe('what a card says', () => {
  it('says what someone outside has to do instead of naming the owner who keeps an eye on it', () => {
    const outside = { who: 'lasse', kind: 'outside', why: 'Waiting for the supplier: API access, key, filters' };
    const scheduled = task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', nextRunAt: local(23, 9), waitingOn: outside, coverage: { ok: true, how: 'checks_back', at: local(23, 9) } });
    expect(cardLine(scheduled, NOW)).toBe('Waiting for the supplier: API access, key, filters; Atlas checks again Mon 09:00.');
    expect(coverageText(scheduled, NOW)).toBe('Waiting for the supplier: API access, key, filters · Atlas checks Mon 09:00');
    const waiting = task({ turn: 'waiting_on_others', group: undefined, waitingOn: { who: 'lasse', kind: 'outside', why: 'The accountant has not filed the VAT return yet.' }, coverage: { ok: false, group: 'nofollow' } });
    expect(cardLine(waiting, NOW)).toBe('The accountant has not filed the VAT return yet.');
    expect(coverageText(waiting, NOW)).toBe('The accountant has not filed the VAT return yet · nobody checks back');
    const customer = task({ turn: 'waiting_on_others', group: undefined, waitingOn: { who: 'kim', kind: 'outside', why: 'reply to the offer' }, coverage: { ok: false, group: 'nofollow' } });
    expect(cardLine(customer, NOW)).toBe('Waiting on kim.');
  });

  it('names the event that put it in its column', () => {
    const asked = task({ group: 'asked', waitingOn: { who: 'lasse', kind: 'question', why: 'Count the 07.11. booking?', since: local(19, 10, 27) }, delegate: 'atlas' });
    expect(cardLine(asked, NOW)).toBe('Count the 07.11. booking?');
    expect(cardTime(asked, NOW)).toEqual({ label: 'asked 10:27', future: false });
    const scheduled = task({ turn: 'agent_scheduled', group: 'at_time', delegate: 'atlas', nextRunAt: local(23, 9) });
    expect(cardLine(scheduled, NOW)).toBe('Atlas starts Mon 09:00.');
    expect(cardTime(scheduled, NOW)).toEqual({ label: 'next Mon 09:00', future: true });
    expect(cardLine(task({ turn: 'needs_you', group: 'nobody', reason: 'no_checkpoint', delegate: 'atlas' }), NOW)).toBe('Delegated without a checkpoint, so nothing will start it.');
    expect(cardLine(task({ turn: 'review', group: undefined, waitingOn: { who: 'lasse', why: 'Review: draft written' } }), NOW)).toBe('draft written');
    expect(cardLine(task({ pending: { opId: 'o', kind: 'hand_over', undoUntil: '' }, delegate: 'atlas' }), NOW)).toMatch(/^Handed to Atlas/);
    expect(cardLine(task({ turn: 'needs_you', group: 'own', handTo: 'atlas' }), NOW)).toBe('You worked on it with Atlas. Hand it to Atlas to let it go on alone.');
  });

  it('says why the runner does not start a delegated task, naming the step it waits for and where that step stands', () => {
    const blocked = (runner: BoardTask['runner'], patch: Partial<BoardTask> = {}) => task({ turn: 'agent_scheduled', group: 'blocked', delegate: 'atlas', runner, ...patch });
    const dep = (step: NonNullable<Extract<NonNullable<BoardTask['runner']>, { kind: 'depends' }>['step']>, more = 0) =>
      ({ kind: 'depends' as const, stepId: 'pr', title: 'open-the-pr', status: 'active', more, step });
    expect(cardLine(blocked(dep({ turn: 'review', waitingOn: { who: 'lasse', kind: 'review', why: 'Review: PR #252 is open against alpha' } })), NOW)).toBe('Waits for your review of PR #252.');
    expect(cardLine(blocked(dep({ turn: 'review', waitingOn: { who: 'lasse', kind: 'review', why: 'Review: copy done' } })), NOW)).toBe('Waits for your review of “Open the pr”.');
    expect(cardLine(blocked(dep({ turn: 'needs_you', group: 'asked', waitingOn: { who: 'lasse', kind: 'go' } })), NOW)).toBe('Waits for your go on “Open the pr”.');
    expect(cardLine(blocked(dep({ turn: 'agent_working', delegate: 'motti' }, 2)), NOW)).toBe('Waits for “Open the pr”, which Motti is working on (and 2 more steps).');
    expect(cardLine(blocked(dep({ turn: 'waiting_on_others', waitingOn: { who: 'kim@acme' } })), NOW)).toBe('Waits for “Open the pr”, which waits on kim@acme.');
    expect(cardLine(blocked({ kind: 'cap', running: 5, max: 5, standalone: true }), NOW)).toBe('Waits for a free slot: 5 of 5 delegated tasks run.');
    expect(cardLine(blocked({ kind: 'cap', running: 5, max: 5, standalone: false }), NOW)).toBe('Waits for a free slot: 5 of 5 steps of its parent run.');
    expect(cardLine(blocked({ kind: 'busy' }), NOW)).toBe('A session is open on it, so the runner leaves it to that session.');
    expect(cardLine(blocked({ kind: 'held' }), NOW)).toMatch(/^Just handed over, or you work on it with Atlas/);
    expect(cardLine(task({ turn: 'needs_you', group: 'parent', delegate: 'atlas', runner: { kind: 'parent', parentId: 'p', status: 'resolved' } }), NOW)).toBe('Its parent task is closed, so it will not start.');
    expect(cardLine(task({ turn: 'needs_you', group: 'parent', delegate: 'atlas', runner: { kind: 'parent', parentId: 'p', status: 'planned' } }), NOW)).toBe('Starts when its parent task is active.');
    expect(cardLine(task({ turn: 'needs_you', group: 'nobody', reason: 'step_dropped', delegate: 'atlas', runner: { kind: 'depends', stepId: 'x', title: 'old-step', status: 'invalidated', more: 0 } }), NOW)).toBe('Waits for “Old step”, which was dropped. Remove the dependency or drop this step.');
    expect(cardLine(task({ turn: 'needs_you', group: 'nobody', reason: 'no_project', delegate: 'atlas', runner: { kind: 'no_project', scope: 'global' } }), NOW)).toMatch(/^Delegated outside a project/);
    expect(cardLine(task({ turn: 'agent_scheduled', group: 'runner', delegate: 'motti', runner: { kind: 'other_member', owner: 'dominik' } }), NOW)).toBe("Motti is next in line on Dominik's cockpit.");
    expect(cardLine(task({ turn: 'agent_scheduled', group: 'runner', delegate: 'atlas' }), NOW)).toBe('Atlas is next in line for the runner.');
    // The reason wins over a status line, as a question or a stop does.
    expect(statusOrTurn(blocked({ kind: 'busy' }, { statusLine: { now: 'Planned.' } as BoardTask['statusLine'] }), NOW)).toBe('A session is open on it, so the runner leaves it to that session.');
    expect(coverageText(blocked(dep({ turn: 'review' }), { coverage: { ok: true, how: 'runner' } }), NOW)).toBe('Atlas · after your review of “Open the pr”');
    expect(columns([blocked({ kind: 'busy' })]).find((c) => c.turn === 'agent_scheduled')!.groups.map((g) => g.group)).toEqual(['blocked']);
  });

  it('colours only Needs you and what is stuck', () => {
    expect(hueOf(task())).toBe('you');
    expect(hueOf(task({ group: 'nobody' }))).toBe('stopped');
    expect(hueOf(task({ turn: 'agent_working', group: undefined }))).toBe('agent');
    expect(hueOf(task({ turn: 'agent_working', group: 'stale' }))).toBe('stopped');
  });

  it('says when a parked task comes back, or that it has no date', () => {
    expect(coverageText(task({ turn: 'parked', coverage: { ok: true, how: 'parked' } }), NOW)).toBe('parked until you bring it back');
    expect(coverageText(task({ turn: 'parked', coverage: { ok: true, how: 'parked', at: new Date(NOW + 86_400_000).toISOString() } }), NOW)).toMatch(/^parked · back /);
  });

  it('reads anchors as titles', () => {
    expect(readable('acme-cancellation-rescue')).toBe('Acme cancellation rescue');
    expect(readable('Already a title')).toBe('Already a title');
    expect(readable('session-2026-11-18-fa1d29c3')).toBe('Session 18 Nov · fa1d29c3');
    expect(readable('single')).toBe('single');
  });
});

describe('Now', () => {
  it('sorts the board by turn, with groups inside Needs you and Agent scheduled', () => {
    const cols = columns([
      task({ id: 'a', group: 'asked', waitingOn: { who: 'lasse', since: local(19, 10) } }),
      task({ id: 'b', group: 'own' }),
      task({ id: 'c', turn: 'agent_scheduled', group: 'runner' }),
    ]);
    expect(cols.map((c) => [c.turn, c.tasks.map((t) => t.id)])).toEqual([
      ['needs_you', ['a', 'b']], ['review', []], ['agent_working', []], ['agent_scheduled', ['c']], ['waiting_on_others', []], ['parked', []], ['done', []],
    ]);
    expect(cols[0].groups.map((g) => g.group)).toEqual(['asked', 'own']);
  });
});

describe('Plan', () => {
  it('splits important tasks into stuck (by reason) and covered', () => {
    const f = focus([
      task({ id: 'ask', important: true, urgency: 1300, coverage: { ok: false, group: 'ask' } }),
      task({ id: 'covered', important: true, coverage: { ok: true, how: 'runner' }, delegate: 'atlas' }),
      task({ id: 'step', important: true, parentId: 'ask', coverage: { ok: false, group: 'mine' } }),
      task({ id: 'minor', coverage: { ok: false, group: 'mine' } }),
    ]);
    expect(f.act).toEqual([{ group: 'ask', tasks: [expect.objectContaining({ id: 'ask' })] }]);
    expect(f.covered.map((t) => t.id)).toEqual(['covered']);
    expect(coverageText(f.covered[0], NOW)).toBe('Atlas · next in line for the runner');
  });

  it('shows the viewer\'s and unowned tasks unless Everyone, and groups by project with steps under their parent', () => {
    const tasks = [task({ id: 'p', urgency: 10 }), task({ id: 's', parentId: 'p', urgency: 99 }), task({ id: 'x', owner: 'dominik', project: 'eml-code' })];
    expect(tasks.filter((t) => visibleInPlan(t, 'lasse', { everyone: false, spaceId: null })).map((t) => t.id)).toEqual(['p', 's']);
    const rows = projectRows(tasks, [{ spaceId: 'main', id: 'acme', name: 'Acme', goal: null }]);
    expect(rows[0]).toMatchObject({ name: 'Acme', open: 2 });
    expect(rows[0].tasks.map((r) => [r.task.id, r.step])).toEqual([['p', false], ['s', true]]);
    expect(rows[1].name).toBe('Eml code');
  });

  it('filters by owner and space for Now too, closed tasks included, and drops a space that is gone', () => {
    const tasks = [task({ id: 'mine' }), task({ id: 'free', owner: undefined }), task({ id: 'other', owner: 'dominik' }), task({ id: 'ebisu', spaceId: 'ebisu' }), task({ id: 'done', status: 'resolved', turn: 'done' })];
    const ids = (f: { everyone: boolean; spaceId: string | null }) => tasks.filter((t) => inFilter(t, 'lasse', f)).map((t) => t.id);
    expect(ids({ everyone: false, spaceId: null })).toEqual(['mine', 'free', 'ebisu', 'done']);
    expect(ids({ everyone: true, spaceId: 'ebisu' })).toEqual(['ebisu']);
    const spaces = [{ id: 'main', name: 'Main', agents: [] }];
    expect(resolveFilter({ everyone: true, spaceId: 'gone' }, spaces)).toEqual({ everyone: true, spaceId: null });
    expect(resolveFilter({ everyone: false, spaceId: 'main' }, spaces)).toEqual({ everyone: false, spaceId: 'main' });
  });

  it('lists the projects the table leaves out, by name, in the chosen space', () => {
    const rows = projectRows([task({ id: 'p' })], []);
    const projects = [
      { spaceId: 'main', id: 'acme', name: 'Acme', goal: null },
      { spaceId: 'main', id: 'brightline', name: 'brightline', goal: null },
      { spaceId: 'main', id: 'pawsome', name: 'Pawsome', goal: 'dogs' },
      { spaceId: 'main', id: 'global', name: 'Global', goal: null },
      { spaceId: 'ebisu', id: 'portfolio', name: 'Portfolio', goal: null },
    ];
    expect(quietProjects(rows, projects, { everyone: false, spaceId: null }).map((p) => p.name)).toEqual(['brightline', 'Pawsome', 'Portfolio']);
    expect(quietProjects(rows, projects, { everyone: false, spaceId: 'ebisu' }).map((p) => p.name)).toEqual(['Portfolio']);
  });
});

describe('loading a project\'s closed tasks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the space, project and limit, and throws on an error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tasks: [], more: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchClosedTasks('main', 'eml-ui-ux', 40)).toEqual({ tasks: [], more: false });
    expect(fetchMock.mock.calls[0]).toEqual(['/api/v1/tasks/closed?spaceId=main&project=eml-ui-ux&limit=40', expect.anything()]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(fetchClosedTasks('main', 'eml-ui-ux', 20)).rejects.toThrow('HTTP 502');
  });
});

describe('starting a session on a task', () => {
  const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  afterEach(() => vi.unstubAllGlobals());

  it('answers the started session', async () => {
    answer(202, { sessionId: 's1' });
    expect(await startTaskSession({ id: 't', spaceId: 'main' })).toEqual({ kind: 'started', sessionId: 's1' });
  });

  it('passes the host\'s refusal on, so nothing starts on a closed task', async () => {
    answer(409, { error: { code: 'task_closed', message: 'The task is closed.', retry: false } });
    expect(await startTaskSession({ id: 't', spaceId: 'main' })).toEqual({ kind: 'refused', message: 'The task is closed.' });
  });

  it('says the route is missing only when an older host has none', async () => {
    answer(404, 'Not found');
    expect(await startTaskSession({ id: 't', spaceId: 'main' })).toEqual({ kind: 'no_route' });
  });

  it('does not know when the host did not answer, since it may have started the session already', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await startTaskSession({ id: 't', spaceId: 'main' })).toEqual({ kind: 'unknown' });
    answer(502, {});
    expect(await startTaskSession({ id: 't', spaceId: 'main' })).toEqual({ kind: 'unknown' });
  });
});

describe('continueMode', () => {
  const NOW = Date.parse('2026-11-24T10:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();

  it('reopens within 7 days, makes a follow-up the main way after, and only a follow-up for a blocked task', () => {
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY_MS) }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: null }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - (REOPEN_DAYS * DAY_MS + 1)) }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY_MS), blocked: 'superseded' }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: false });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY_MS), blocked: 'parent_closed' }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: false });
  });

  it('offers neither on someone else\'s task', () => {
    expect(continueMode({ owner: 'dominik', closedAt: at(NOW) }, 'lasse', NOW)).toBeNull();
    expect(continueMode({ closedAt: at(NOW) }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
  });
});

describe('the task state screens (v0.23)', () => {
  const run = (patch: Partial<NonNullable<BoardTask['runs']>[number]>) => ({ id: 'r', member: 'dominik', agent: 'motti', state: 'running' as const, lastActivityAt: new Date(NOW - 3 * 60_000).toISOString(), result: null, here: false, ...patch });

  it('says whose cockpit works on a task, and when a run went silent', () => {
    expect(cardLine(task({ turn: 'agent_working', group: undefined, delegate: 'atlas', runs: [run({})] }), NOW)).toBe("Motti is working on it, on Dominik's cockpit.");
    expect(cardLine(task({ turn: 'agent_working', group: undefined, delegate: 'atlas', runs: [run({ here: true, agent: 'atlas' })] }), NOW)).toBe('Atlas is working on it.');
    expect(cardLine(task({ turn: 'agent_working', group: 'stale', delegate: 'atlas', runs: [run({ state: 'stale', agent: 'atlas' })] }), NOW)).toMatch(/^Atlas has been silent since .*It may have crashed: open it or run it again\.$/);
  });

  it('names a mission, a routine and work that starts later', () => {
    const at = new Date(NOW + DAY_MS).toISOString();
    expect(cardLine(task({ turn: 'agent_scheduled', group: 'mission', delegate: 'atlas', nextRunAt: at }), NOW)).toMatch(/^Until the goal is reached\. Atlas checks again /);
    expect(cardLine(task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', nextRunAt: at, schedule: { crons: ['0 8 * * 1-5'] } }), NOW)).toMatch(/^Repeats on weekdays at 08:00\. Next /);
    // past its end the repeating times repeat no more; a wake-up ahead is still its next run
    expect(cardLine(task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', nextRunAt: local(23, 9), schedule: { crons: ['0 8 * * 1-5'], at: local(23, 9), ends_at: local(18, 9) } }), NOW)).toBe('Its repeating times have ended. Next Mon 09:00.');
    expect(repeatsText({ crons: ['30 9 * * 1'] })).toBe('Repeats every Monday at 09:30');
    expect(repeatsText({ crons: ['0 7 1 1 *'] })).toBe('Repeats (0 7 1 1 *)');
  });

  it('groups Needs you and Agent scheduled by the new groups, and keeps working tasks next to the Stale group', () => {
    const cols = columns([
      task({ id: 'f', group: 'failed', reason: 'stopped' }), task({ id: 'a', group: 'asked' }),
      task({ id: 'm', turn: 'agent_scheduled', group: 'mission' }), task({ id: 'r', turn: 'agent_scheduled', group: 'routine' }), task({ id: 'l', turn: 'agent_scheduled', group: 'at_time' }),
      task({ id: 'w', turn: 'agent_working', group: undefined }), task({ id: 's', turn: 'agent_working', group: 'stale' }),
    ]);
    expect(cols.find((c) => c.turn === 'needs_you')!.groups.map((g) => g.group)).toEqual(['asked', 'failed']);
    expect(cols.find((c) => c.turn === 'agent_scheduled')!.groups.map((g) => g.group)).toEqual(['mission', 'routine', 'at_time']);
    const working = cols.find((c) => c.turn === 'agent_working')!;
    expect([working.tasks.map((t) => t.id).sort(), working.groups.map((g) => g.group)]).toEqual([['s', 'w'], ['stale']]);
  });
});

describe('a task whose schedule is still on', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is scheduled while it is open and the host says its schedule is on, with or without a next run', () => {
    const next = new Date(NOW + DAY_MS).toISOString();
    expect(isScheduled(task({ hasSchedule: true, nextRunAt: next }))).toBe(true);
    expect(isScheduled(task({ turn: 'review', hasSchedule: true }))).toBe(true);
    // a paused schedule: no run is coming up, the schedule is on all the same
    expect(isScheduled(task({ hasSchedule: true, nextRunAt: null, schedule: { crons: ['0 8 * * 1-5'], paused: true } }))).toBe(true);
    expect(isScheduled(task())).toBe(false);
    // a next run alone does not decide it: the host does
    expect(isScheduled(task({ nextRunAt: next }))).toBe(false);
    expect(isScheduled(task({ status: 'resolved', hasSchedule: true }))).toBe(false);
    expect(isScheduled(task({ status: 'invalidated', hasSchedule: true }))).toBe(false);
  });

  it('says what a click that can still be undone does: a run approved, a task closed as reviewed, a schedule ended', () => {
    const pending = (kind: string) => ({ opId: 'o', kind, undoUntil: '' });
    // The host shows a scheduled task as still open while its review is pending, any other as closed.
    expect(cardLine(task({ hasSchedule: true, pending: pending('review') }), NOW)).toBe('Run approved. You can undo this for a few seconds.');
    expect(cardLine(task({ status: 'resolved', turn: 'done', pending: pending('review') }), NOW)).toBe('Closing as reviewed. You can undo this for a few seconds.');
    expect(cardLine(task({ status: 'resolved', turn: 'done', hasSchedule: true, pending: pending('end_schedule') }), NOW)).toBe('Ending its schedule and closing. You can undo this for a few seconds.');
  });

  it('ends its schedule through end-schedule, with the op id and the space', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ opId: 'op-9', state: 'pending', undoUntil: '2026-11-19T10:35:08.000Z' }), { status: 202 }));
    vi.stubGlobal('fetch', fetched);
    expect(await endSchedule({ id: 'daily brief', spaceId: 'main' }, 'op-9')).toEqual({ ok: true, opId: 'op-9', state: 'pending', undoUntil: '2026-11-19T10:35:08.000Z' });
    const [url, init] = fetched.mock.calls[0];
    expect(url).toBe('/api/v1/tasks/daily%20brief/end-schedule');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ opId: 'op-9', spaceId: 'main' });
  });

  it('takes a task over without a desk, with its delegate and checkpoint, and passes on the session it opens', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ opId: 'op-7', state: 'applied', undoUntil: '2026-11-25T10:00:08.000Z', sessionId: 's1' }), { status: 202 }));
    vi.stubGlobal('fetch', fetched);
    expect(await takeOver({ id: 't', spaceId: 'main', delegate: 'atlas', checkpoint: 'before' }, 'op-7')).toEqual({ ok: true, opId: 'op-7', state: 'applied', undoUntil: '2026-11-25T10:00:08.000Z', sessionId: 's1' });
    const [url, init] = fetched.mock.calls[0];
    expect(url).toBe('/api/v1/tasks/t/hand-over');
    expect(JSON.parse(String(init?.body))).toEqual({ opId: 'op-7', spaceId: 'main', mode: 'together', delegate: 'atlas', checkpoint: 'before' });
  });

  it('passes on why the host refused: Close on a scheduled task, End schedule with open steps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'scheduled', message: 'Its schedule is still on: use End schedule and close.', retry: false } }), { status: 409 })));
    expect(await closeTask({ id: 't', spaceId: 'main' })).toEqual({ ok: false, code: 'scheduled', message: 'Its schedule is still on: use End schedule and close.', retry: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'open_steps', message: 'Two steps are still open.', retry: false } }), { status: 409 })));
    expect(await endSchedule({ id: 't', spaceId: 'main' })).toEqual({ ok: false, code: 'open_steps', message: 'Two steps are still open.', retry: false });
  });
});

describe('the task panel logic (v0.23)', () => {
  const run = (state: 'running' | 'idle' | 'stale') => ({ id: 's1', member: 'lasse', agent: 'atlas', state, lastActivityAt: new Date(NOW - 60_000).toISOString(), here: true });

  it('names a session by what it needs: the task waits on it, put away, silent, working, idle', () => {
    const asked = task({ waitingOn: { who: 'lasse', kind: 'question', session_id: 's1' } });
    expect(sessionState(asked, 's1', false, run('running'))).toBe('needs input');
    expect(sessionState(task({ waitingOn: { who: 'lasse', kind: 'review', session_id: 's1' } }), 's1', false, undefined)).toBe('review');
    expect(sessionState(task(), 's1', true, run('running'))).toBe('done');
    expect(sessionState(task(), 's1', false, run('stale'))).toBe('silent');
    expect(sessionState(task(), 's1', false, run('running'))).toBe('working');
    expect(sessionState(task(), 's1', false, undefined)).toBe('idle');
  });

  it('says whose move it is in one line, and offers what the state calls for', () => {
    expect(waitingLine(task({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'question', why: 'A? · B?' } }), 'lasse')).toBe('You · 2 questions from Atlas');
    expect(waitingLine(task({ waitingOn: { who: 'kim', kind: 'outside', why: 'reply to the offer' } }), 'lasse')).toBe('kim · reply to the offer');
    expect(waitingLine(task({ waitingOn: { who: 'lasse', kind: 'outside', why: 'Waiting for the supplier' } }), 'lasse')).toBe('Outside · Waiting for the supplier');
    expect(panelActions(task({ group: 'asked' }), true)).toEqual([]);
    expect(panelActions(task({ group: 'asked', delegate: 'atlas', goal: 'Kept' }), false)).toEqual(['together', 'run_now']);
    expect(panelActions(task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', goal: 'Sent', nextRunAt: new Date(NOW + DAY_MS).toISOString() }), true)).toEqual(['run_now', 'together']);
    expect(panelActions(task({ group: 'own', goal: 'Shipped' }), true)).toEqual(['delegate_now', 'schedule', 'together']);
  });

  it('offers Delegate on a task with you that has a name and a goal, and Take over on one the agent works on alone', () => {
    const own = { sessionId: 's1', continues: true };
    // with you: Delegate only with a goal and never on a placeholder; no Work on it now while it has its own session
    expect(panelActions(task({ group: 'own', goal: 'Shipped', ownSession: own }), true)).toEqual(['delegate_now', 'schedule']);
    // nothing that hands it to an agent alone (Delegate, Schedule, Run, Hand to) without a goal or on a placeholder
    expect(panelActions(task({ group: 'own' }), true)).toEqual(['together']);
    expect(panelActions(task({ group: 'own', goal: 'Shipped', title: 'session-2026-11-25-2ee4035f' }), true)).toEqual(['together']);
    expect(panelActions(task({ group: 'own', handTo: 'atlas' }), true)).toEqual(['together']);
    expect(panelActions(task({ group: 'asked', delegate: 'atlas' }), false)).toEqual(['together']);
    expect(panelActions(task({ group: 'own', goal: 'Shipped', title: 'session-2026-11-25-2ee4035f', displayTitle: 'Fix the sync' }), true)).toEqual(['delegate_now', 'schedule', 'together']);
    // the agent works alone: Take over opens its session; Work on it now only without one
    expect(panelActions(task({ turn: 'agent_working', group: undefined, delegate: 'atlas', ownSession: own }), true)).toEqual(['take_over']);
    expect(panelActions(task({ turn: 'agent_working', group: undefined, delegate: 'atlas' }), true)).toEqual(['together']);
    expect(panelActions(task({ turn: 'agent_scheduled', group: 'routine', delegate: 'atlas', goal: 'Sent', ownSession: own, nextRunAt: new Date(NOW + DAY_MS).toISOString() }), true)).toEqual(['run_now', 'take_over']);
  });

  it('names the mode: with you, or the agent works alone', () => {
    expect(taskMode(task())).toBe('with_you');
    expect(modeLabel(task())).toBe('With you');
    expect(taskMode(task({ delegate: 'atlas' }))).toBe('alone');
    expect(modeLabel(task({ delegate: 'atlas' }))).toBe('Atlas works alone');
  });

  it('times a working card by its last activity: a running run first, then any run, then the task', () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    const runs = [{ ...run('idle'), id: 'a', lastActivityAt: at(30) }, { ...run('running'), id: 'b', lastActivityAt: at(2) }];
    expect(cardTime(task({ turn: 'agent_working', group: undefined, runs }), NOW)?.label).toBe(`last activity ${when(at(2), NOW)}`);
    expect(cardTime(task({ turn: 'agent_working', group: undefined, runs: [runs[0]] }), NOW)?.label).toBe(`last activity ${when(at(30), NOW)}`);
    expect(cardTime(task({ turn: 'agent_working', group: undefined, updatedAt: at(90) }), NOW)?.label).toBe(`last activity ${when(at(90), NOW)}`);
  });
});

describe('a delegated task whose session is open but idle', () => {
  it('says the session waits and times the card by its last activity', () => {
    const at = new Date(NOW - 45 * 60_000).toISOString();
    const idle = task({ turn: 'needs_you', group: 'nobody', reason: 'idle', delegate: 'atlas', runs: [{ id: 's1', member: 'lasse', agent: 'atlas', state: 'idle' as const, lastActivityAt: at, here: true }] });
    expect(cardLine(idle, NOW)).toBe('Its session is open but idle: nothing asked, nothing scheduled. Write to it or close the task.');
    expect(cardTime(idle, NOW)?.label).toBe(`idle since ${when(at, NOW)}`);
    expect(hueOf(idle)).toBe('stopped');
  });
});

describe('an earlier session in one line', () => {
  it('says the agent, when, how it ended and its result line', () => {
    const run = { id: 'r', member: 'lasse', agent: 'atlas', startedAt: new Date(NOW - DAY_MS).toISOString(), endedAt: null, endReason: 'finished', result: '4 mails need you', here: true };
    expect(earlierRunLine(run, NOW)).toBe(`Atlas · ${when(run.startedAt, NOW)} · finished · 4 mails need you`);
    expect(earlierRunLine({ ...run, endReason: 'crashed', result: null }, NOW)).toBe(`Atlas · ${when(run.startedAt, NOW)} · stopped with the cockpit`);
  });
});

describe('taskSessionsKey', () => {
  it('changes when any task is renamed, closed and lineage ones included, and not when only the order moves', () => {
    const a = task({ id: 'a', title: 'fix-stock', displayTitle: 'Fix the stock' });
    const b = task({ id: 'b', title: 'plain-anchor' });
    const closed = { ...task({ id: 'c', title: 'done-one' }), closedAt: null } as never;
    const lineage = { id: 'l', spaceId: 'main', project: 'acme', title: 'root', status: 'resolved', parentId: null, originId: null };
    const key = taskSessionsKey({ tasks: [a, b], closed: [closed], lineage: [lineage] });
    expect(taskSessionsKey({ tasks: [b, a], closed: [closed], lineage: [lineage] })).toBe(key);
    expect(taskSessionsKey({ tasks: [{ ...a, displayTitle: 'Fix the stock answers' }, b], closed: [closed], lineage: [lineage] })).not.toBe(key);
    expect(taskSessionsKey({ tasks: [a, { ...b, title: 'other-anchor' }], closed: [closed], lineage: [lineage] })).not.toBe(key);
    expect(taskSessionsKey({ tasks: [a, b], closed: [{ ...(closed as object), displayTitle: 'Renamed' } as never], lineage: [lineage] })).not.toBe(key);
    expect(taskSessionsKey({ tasks: [a, b], closed: [closed], lineage: [{ ...lineage, displayTitle: 'Root' }] })).not.toBe(key);
    expect(taskSessionsKey({ tasks: [a, b] })).toBe(taskSessionsKey({ tasks: [a, b], closed: [], lineage: [] }));
  });

  it('changes when a task closes or its wait moves to another session: its sessions may no longer wait for you', () => {
    const a = task({ id: 'a', title: 'fix-stock', status: 'active' });
    const key = taskSessionsKey({ tasks: [a] });
    expect(taskSessionsKey({ tasks: [{ ...a, status: 'resolved' }] })).not.toBe(key);
    const waiting = { ...a, waitingOn: { who: 'lasse', kind: 'question' as const, why: 'Which one?', since: '2026-11-25T10:00:00Z', session_id: 's1' } };
    expect(taskSessionsKey({ tasks: [waiting] })).not.toBe(key);
    expect(taskSessionsKey({ tasks: [{ ...waiting, waitingOn: { ...waiting.waitingOn, why: 'Reworded' } }] })).toBe(taskSessionsKey({ tasks: [waiting] }));
  });
});

describe('a task holds its schedule', () => {
  afterEach(() => { vi.unstubAllGlobals(); setTimeZoneForTest(null); });

  it('says a repeating time in words, as the host says it to a session; a rule the words do not fit stays a rule', () => {
    expect(cronWords('0 8 * * 1-5')).toBe('on weekdays at 08:00');
    expect(cronWords('0 18,22 * * *')).toBe('every day at 18:00 and 22:00');
    expect(cronWords('30 9 * * 1,4')).toBe('every Monday and Thursday at 09:30');
    expect(cronWords('0 10 * * 0,6')).toBe('at the weekend at 10:00');
    expect(cronWords('0 9 * * 7')).toBe('every Sunday at 09:00');
    expect(cronWords('0 7 1 * *')).toBe('on day 1 of every month at 07:00');
    expect(cronWords('15 * * * *')).toBe('every hour at :15');
    expect(cronWords('15 * * * 1')).toBe('every hour at :15 on Monday');
    expect(cronWords('*/5 * * * *')).toBeNull();
    expect(cronWords('0 8 1 * 1')).toBeNull();
    expect(cronWords('0 8 * 6 *')).toBeNull();
    expect(cronWords('0 25 * * *')).toBeNull();
    expect(cronWords('not a cron')).toBeNull();
    expect(timeText('0 8 * * 1-5')).toBe('On weekdays at 08:00');
    expect(timeText('*/5 * * * *')).toBe('*/5 * * * *');
  });

  it('says several repeating times one after the other, and names their zone only when it is not the user\'s', () => {
    setTimeZoneForTest('Asia/Makassar');
    const schedule = { crons: ['0 13 * * 1-5', '0 18,22 * * 1-5', '*/5 * * * *'], time_zone: 'Asia/Makassar' };
    expect(repeatsText(schedule)).toBe('Repeats on weekdays at 13:00; on weekdays at 18:00 and 22:00; (*/5 * * * *)');
    expect(scheduleZone(schedule)).toBeNull();
    setTimeZoneForTest('Europe/Berlin');
    expect(scheduleZone(schedule)).toBe('Asia/Makassar');
    expect(repeatsText({ crons: ['0 8 * * *'], time_zone: 'Asia/Makassar' })).toBe('Repeats every day at 08:00 (Asia/Makassar)');
    // a wake-up alone repeats nothing
    expect(repeatsText({ at: local(23, 9) })).toBe('Repeats');
    expect(repeatsText(undefined)).toBe('Repeats');
  });

  it('reads a next run whose time has come as due, not as a time in the past', () => {
    const past = local(19, 10, 27), ahead = local(23, 9);
    expect(isDue(past, NOW)).toBe(true);
    expect(isDue(ahead, NOW)).toBe(false);
    expect(isDue(null, NOW)).toBe(false);
    expect(nextRunText(ahead, NOW)).toBe('next Mon 09:00');
    expect(nextRunText(past, NOW)).toBe('due since 10:27');
    expect(nextRunText(null, NOW)).toBe('');
    const scheduled = (patch: Partial<BoardTask>) => task({ turn: 'agent_scheduled', delegate: 'atlas', nextRunAt: past, hasSchedule: true, ...patch });
    expect(cardLine(scheduled({ group: 'at_time' }), NOW)).toBe('Atlas\'s run is due since 10:27.');
    expect(cardLine(scheduled({ group: 'mission' }), NOW)).toBe('Until the goal is reached. Atlas\'s run is due since 10:27.');
    expect(cardLine(scheduled({ group: 'routine', schedule: { crons: ['0 8 * * 1-5'] } }), NOW)).toBe('Repeats on weekdays at 08:00. Due since 10:27.');
    expect(cardLine(scheduled({ group: 'routine', nextRunAt: ahead, schedule: { crons: ['0 8 * * 1-5'] } }), NOW)).toBe('Repeats on weekdays at 08:00. Next Mon 09:00.');
    expect(cardLine(task({ turn: 'waiting_on_others', delegate: 'atlas', nextRunAt: past, waitingOn: { who: 'supplier', kind: 'outside' } }), NOW)).toBe('Waiting on supplier; Atlas\'s run is due since 10:27.');
    expect(cardTime(scheduled({ group: 'at_time' }), NOW)).toEqual({ label: 'due since 10:27', future: true });
    expect(coverageText(scheduled({ group: 'at_time', coverage: { ok: true, how: 'at_time', at: past } }), NOW)).toBe('Atlas · due since 10:27');
    expect(coverageText(scheduled({ group: 'at_time', coverage: { ok: true, how: 'at_time', at: ahead } }), NOW)).toBe('Atlas · Mon 09:00');
    expect(coverageText(scheduled({ waitingOn: { who: 'supplier', kind: 'outside' }, coverage: { ok: true, how: 'checks_back', at: past } }), NOW)).toBe('waiting on supplier · Atlas due since 10:27');
  });

  it('knows the one time whose removal ends the schedule: the only repeating time of a task without a wake-up', () => {
    expect(isLastTime({ crons: ['0 8 * * 1-5'] }, '0 8 * * 1-5')).toBe(true);
    expect(isLastTime({ crons: ['0 8 * * 1-5', '0 18 * * *'] }, '0 8 * * 1-5')).toBe(false);
    expect(isLastTime({ crons: ['0 8 * * 1-5'], at: local(23, 9) }, '0 8 * * 1-5')).toBe(false);
  });

  it('sends each control of the schedule to its route with the op id and the space; a time to remove by its rule', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ opId: 'op-1', state: 'applied', undoUntil: '2026-11-19T10:35:00.000Z' }), { status: 202 }));
    vi.stubGlobal('fetch', fetched);
    const t = { id: 'daily brief', spaceId: 'main' };
    expect(await pauseSchedule(t, 'op-1')).toEqual({ ok: true, opId: 'op-1', state: 'applied', undoUntil: '2026-11-19T10:35:00.000Z' });
    await resumeSchedule(t, 'op-2');
    await runNow(t, 'op-3');
    await removeTime(t, '0 8 * * 1-5', 'op-4');
    expect(fetched.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ['/api/v1/tasks/daily%20brief/pause-schedule', { opId: 'op-1', spaceId: 'main' }],
      ['/api/v1/tasks/daily%20brief/resume-schedule', { opId: 'op-2', spaceId: 'main' }],
      ['/api/v1/tasks/daily%20brief/run-now', { opId: 'op-3', spaceId: 'main' }],
      ['/api/v1/tasks/daily%20brief/remove-time', { opId: 'op-4', spaceId: 'main', cron: '0 8 * * 1-5' }],
    ]);
  });

  it('passes on why the host refused a control', async () => {
    const refuse = (code: string, message: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code, message, retry: false } }), { status: 409 })));
    refuse('run_open', 'Its last run is still going: wait for it to finish.');
    expect(await runNow({ id: 't', spaceId: 'main' })).toEqual({ ok: false, code: 'run_open', message: 'Its last run is still going: wait for it to finish.', retry: false });
    refuse('unknown_time', 'Its schedule has no repeating time "0 9 * * *".');
    expect(await removeTime({ id: 't', spaceId: 'main' }, '0 9 * * *')).toMatchObject({ ok: false, code: 'unknown_time' });
  });

  it('says what a control did once it went through', () => {
    const t = task({ schedule: { crons: ['0 8 * * 1-5', '0 18 * * *'] } });
    expect(scheduleDone(t, { kind: 'pause' })).toBe('Schedule paused: nothing runs until you resume it.');
    expect(scheduleDone(t, { kind: 'resume' })).toBe('Schedule resumed.');
    expect(scheduleDone(t, { kind: 'run_now' })).toBe('Run started: how it goes shows under its last runs.');
    expect(scheduleDone(t, { kind: 'remove_time', cron: '0 18 * * *' })).toBe('Time removed.');
    expect(scheduleDone(task({ schedule: { crons: ['0 18 * * *'] } }), { kind: 'remove_time', cron: '0 18 * * *' })).toBe('Time removed and schedule ended. The task stays open.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'approve' } })).toBe('Approved: its messages wake the task from now.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'reply', channel: 'mail', mode: 'send' } })).toBe('Its mail replies are sent without asking.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'reply', channel: 'mail', mode: 'draft' } })).toBe('Its mail replies are drafts you approve.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'limited', limited: true } })).toBe('Its sessions are limited.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'grant', tool: 'chrome' } })).toBe('Chrome lent for 1 h.');
    expect(scheduleDone(t, { kind: 'record', change: { kind: 'revoke', tool: 'SendMessage' } })).toBe('Messages taken back.');
  });

  const record = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ id: 't', triggers: [], reply: {}, pausedReason: null, ...patch });

  it('reads what this cockpit keeps for the task, in the task\'s space', async () => {
    const view = { record: record(), runs: [], held: false, running: false };
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(view), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    expect(await fetchTaskRecord({ id: 'daily brief', spaceId: 'team space' })).toEqual(view);
    expect(fetched.mock.calls[0][0]).toBe('/api/v1/tasks/daily%20brief/record?spaceId=team+space');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(fetchTaskRecord({ id: 't', spaceId: 'main' })).rejects.toThrow('HTTP 503');
  });

  it('changes a setting of the record through its route, and passes on a refusal', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ text: 'ok', record: record() }), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    const t = { id: 't', spaceId: 'main' };
    expect(await changeRecord(t, { kind: 'approve' })).toEqual({ ok: true });
    await changeRecord(t, { kind: 'reply', channel: 'mail', mode: 'send' });
    await changeRecord(t, { kind: 'limited', limited: false });
    await changeRecord(t, { kind: 'grant', tool: 'chrome' });
    await changeRecord(t, { kind: 'revoke', tool: 'SendMessage' });
    expect(fetched.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ['/api/v1/tasks/t/record/approve', { spaceId: 'main' }],
      ['/api/v1/tasks/t/record/reply', { spaceId: 'main', channel: 'mail', mode: 'send' }],
      ['/api/v1/tasks/t/record/limited', { spaceId: 'main', limited: false }],
      ['/api/v1/tasks/t/record/grant', { spaceId: 'main', tool: 'chrome' }],
      ['/api/v1/tasks/t/record/revoke', { spaceId: 'main', tool: 'SendMessage' }],
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'no_record', message: 'This cockpit keeps no schedule settings for the task yet.' } }), { status: 404 })));
    expect(await changeRecord(t, { kind: 'approve' })).toEqual({ ok: false, code: 'no_record', message: 'This cockpit keeps no schedule settings for the task yet.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await changeRecord(t, { kind: 'approve' })).toEqual({ ok: false, code: 'offline', message: 'The cockpit did not answer.' });
  });

  it('shows the record\'s settings only when it has something to show', () => {
    const lent = { tool: 'chrome' as const, until: new Date(NOW + 60_000).toISOString(), reason: null };
    const over = { tool: 'SendMessage' as const, until: new Date(NOW - 60_000).toISOString(), reason: null };
    expect(recordShows(null, NOW)).toBe(false);
    expect(recordShows(record(), NOW)).toBe(false);
    expect(recordShows(record({ grants: [over] }), NOW)).toBe(false);
    expect(recordShows(record({ triggers: [{ type: 'mail' }] }), NOW)).toBe(true);
    expect(recordShows(record({ pendingApproval: true }), NOW)).toBe(true);
    expect(recordShows(record({ limited: true }), NOW)).toBe(true);
    expect(recordShows(record({ grants: [lent] }), NOW)).toBe(true);
    expect(activeGrants(record({ grants: [lent, over] }), NOW)).toEqual([lent]);
  });

  it('says a run in one line: when, what fired it besides its schedule, how it went and why not', () => {
    const run = (patch: Partial<TaskRun>): TaskRun => ({ id: 'r', number: 1, trigger: 'schedule', dueAt: local(19, 8), status: 'finished', sessionId: 's', startedAt: local(19, 8, 1), finishedAt: local(19, 8, 9), outcome: 'review', note: null, session: { projectId: null, chat: true, attention: 'review' }, ...patch });
    expect(runLine(run({}), NOW, true)).toEqual({ text: '08:01 · check this', tone: 'attention' });
    expect(runLine(run({ session: { projectId: null, chat: true, attention: null } }), NOW, true)).toEqual({ text: '08:01 · seen', tone: 'muted' });
    expect(runLine(run({ trigger: 'manual', outcome: 'done' }), NOW)).toEqual({ text: '08:01 · run by hand · done', tone: 'ok' });
    expect(runLine(run({ trigger: 'mail', outcome: 'done' }), NOW)).toEqual({ text: '08:01 · on mail · done', tone: 'ok' });
    expect(runLine(run({ number: 0, status: 'skipped', startedAt: null, finishedAt: null, sessionId: null, session: null, outcome: null, note: 'a session of the task was working' }), NOW))
      .toEqual({ text: '08:00 · skipped · a session of the task was working', tone: 'muted' });
  });
});

describe('asks and check-backs (decision asks-and-check-backs-are-separate)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Done, Remove and Reschedule of the wake-up to their routes, with the op id and the space', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ opId: 'op-1', state: 'applied', undoUntil: '2026-11-19T10:35:00.000Z' }), { status: 202 }));
    vi.stubGlobal('fetch', fetched);
    const t = { id: 'offer 1', spaceId: 'main' };
    expect(await markDone({ taskId: 'offer 1', space: 'main', waitId: 'w1' }, 'op-1')).toMatchObject({ ok: true, opId: 'op-1' });
    await removeWake(t, 'op-2');
    await rescheduleWake(t, '2026-11-23T07:30:00.000Z', 'op-3');
    expect(fetched.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ['/api/v1/tasks/offer%201/done', { opId: 'op-1', spaceId: 'main', waitId: 'w1' }],
      ['/api/v1/tasks/offer%201/remove-wake', { opId: 'op-2', spaceId: 'main' }],
      ['/api/v1/tasks/offer%201/reschedule-wake', { opId: 'op-3', spaceId: 'main', at: '2026-11-23T07:30:00.000Z' }],
    ]);
  });

  it('passes a refusal on in the host\'s words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unknown_wait', message: 'That step is not open any more.', retry: false } }), { status: 409 })));
    expect(await markDone({ taskId: 't', space: 'main', waitId: 'gone' })).toEqual({ ok: false, code: 'unknown_wait', message: 'That step is not open any more.', retry: false });
  });

  it('says what Remove and Reschedule did', () => {
    expect(scheduleDone(task(), { kind: 'remove_wake' })).toBe('Wake-up removed.');
    // Said against the real clock: the day part depends on today.
    expect(scheduleDone(task(), { kind: 'reschedule_wake', at: local(19, 15) })).toMatch(/^Wake-up moved to .*15:00\.$/);
  });

  it('a task repeats only with repeating times: a wake-up alone ends with it', () => {
    expect(repeats(task({ hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'] } }))).toBe(true);
    expect(repeats(task({ hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'], at: local(20, 9) } }))).toBe(true);
    expect(repeats(task({ hasSchedule: true, schedule: { at: local(20, 9), by: 'atlas' } }))).toBe(false);
    // A schedule the board does not spell out counts as repeating.
    expect(repeats(task({ hasSchedule: true }))).toBe(true);
    expect(repeats(task({ status: 'resolved', hasSchedule: true, schedule: { crons: ['0 8 * * 1-5'] } }))).toBe(false);
  });

  it('says when a step is due: today, overdue, tomorrow, or the date; an instant with its time', () => {
    expect(askDueLabel('2026-11-19', NOW)).toEqual({ text: 'due today', overdue: false });
    expect(askDueLabel('2026-11-18', NOW)).toEqual({ text: 'overdue', overdue: true });
    expect(askDueLabel('2026-11-20', NOW)).toEqual({ text: 'due tomorrow', overdue: false });
    expect(askDueLabel('2026-12-02', NOW)).toEqual({ text: 'due 2 Dec', overdue: false });
    expect(askDueLabel(local(19, 17), NOW)).toEqual({ text: 'due today 17:00', overdue: false });
    expect(askDueLabel(local(23, 9), NOW)).toEqual({ text: 'due Mon 09:00', overdue: false });
    expect(askDueLabel(local(19, 9), NOW)).toEqual({ text: 'overdue', overdue: true });
  });

  it('says who checks back and when: an agent, a reminder for the viewer, or a wake-up that names nobody', () => {
    expect(checkBackText({ at: local(20, 9), by: 'nova' }, 'lasse', NOW)).toBe('Nova checks back tomorrow 09:00');
    expect(checkBackText({ at: local(20, 9), by: 'lasse' }, 'lasse', NOW)).toBe('Reminder tomorrow 09:00');
    expect(checkBackText({ at: local(20, 9), by: 'lasse' }, 'lasse', NOW, 'Reminder for you')).toBe('Reminder for you tomorrow 09:00');
    expect(checkBackText({ at: local(19, 15), by: null }, 'lasse', NOW)).toBe('Wake-up 15:00');
    expect(checkBackOf(task({ schedule: { at: local(20, 9), by: 'nova' } }))).toEqual({ at: local(20, 9), by: 'nova' });
    expect(checkBackOf(task({ schedule: { crons: ['0 8 * * *'] } }))).toBeNull();
  });

  it('Looks good says that it closes the task and ends the check, unless the task repeats', () => {
    const check = { at: local(20, 9), by: 'nova' };
    expect(looksGoodLabel({ checkBack: check }, 'lasse')).toBe('Looks good · closes the task, ends Nova\'s check');
    expect(looksGoodLabel({ checkBack: { ...check, by: 'lasse' } }, 'lasse')).toBe('Looks good · closes the task, ends your reminder');
    expect(looksGoodLabel({ checkBack: { ...check, by: null } }, 'lasse')).toBe('Looks good · closes the task, ends the check');
    expect(looksGoodLabel({ checkBack: check, repeating: true }, 'lasse')).toBe('Looks good');
    expect(looksGoodLabel({}, 'lasse')).toBe('Looks good');
  });

  it('a do wait is the viewer\'s move: on the card, in the panel and as a step another task waits for', () => {
    const mine = task({ group: 'asked', delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'do', why: 'Send the signed offer' } });
    expect(cardLine(mine, NOW)).toBe('Your move: Send the signed offer.');
    expect(cardLine(task({ group: 'asked', waitingOn: { who: 'lasse', kind: 'do' } }), NOW)).toBe('Your move.');
    expect(waitingLine(mine, 'lasse')).toBe('Your move · Send the signed offer');
    expect(waitingLine(task({ waitingOn: { who: 'lasse', kind: 'do' } }), 'lasse')).toBe('Your move');
    const after = task({ group: 'blocked', delegate: 'atlas', runner: { kind: 'depends', stepId: 's', title: 'sign-offer', status: 'active', more: 0, step: { turn: 'needs_you', group: 'asked', waitingOn: { who: 'lasse', kind: 'do' } } } });
    expect(cardLine(after, NOW)).toBe('Waits for your move on “Sign offer”.');
  });
});
