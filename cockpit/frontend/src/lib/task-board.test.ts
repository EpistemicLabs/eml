import { afterEach, describe, expect, it, vi } from 'vitest';

import { cardLine, cardTime, columns, coverageText, dueLabel, focus, hueOf, inFilter, projectRows, quietProjects, readable, resolveFilter, snoozeTimes, startTaskSession, visibleInPlan, when, type BoardTask } from './task-board';

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
