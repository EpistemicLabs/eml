import { afterEach, describe, expect, it, vi } from 'vitest';

import { cardLine, cardTime, columns, continueMode, coverageText, REOPEN_DAYS, statusOrTurn, dueLabel, fetchClosedTasks, focus, hueOf, inFilter, projectRows, quietProjects, readable, resolveFilter, snoozeTimes, startTaskSession, visibleInPlan, when, type BoardTask } from './task-board';

const NOW = new Date(2026, 10, 19, 10, 35).getTime(); // Thu 19 Nov 2026, 10:35 local
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'acme-cancellation-rescue', status: 'active', parentId: null, updatedAt: local(19, 9),
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, owner: 'lasse', ...patch,
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
});

describe('what a card says', () => {
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
      ['needs_you', ['a', 'b']], ['review', []], ['agent_working', []], ['agent_scheduled', ['c']], ['waiting_on_others', []], ['done', []],
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
  const DAY = 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(ms).toISOString();

  it('reopens within 7 days, makes a follow-up the main way after, and only a follow-up for a blocked task', () => {
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY) }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: null }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - (REOPEN_DAYS * DAY + 1)) }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: true });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY), blocked: 'superseded' }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: false });
    expect(continueMode({ owner: 'lasse', closedAt: at(NOW - DAY), blocked: 'parent_closed' }, 'lasse', NOW)).toMatchObject({ primary: 'follow_up', reopen: false });
  });

  it('offers neither on someone else\'s task', () => {
    expect(continueMode({ owner: 'dominik', closedAt: at(NOW) }, 'lasse', NOW)).toBeNull();
    expect(continueMode({ closedAt: at(NOW) }, 'lasse', NOW)).toEqual({ primary: 'reopen', reopen: true });
  });
});
