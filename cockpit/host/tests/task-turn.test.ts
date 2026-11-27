import { describe, it, expect } from 'vitest'
import { coverageOf, isImportant, turnOf, urgencyOf, waitKind, type LiveFacts, type TaskFacts } from '../src/domain/task-turn.js'

const NOW = Date.parse('2026-11-19T10:00:00Z')
const task = (patch: Partial<TaskFacts> = {}): TaskFacts => ({ status: 'active', owner: 'lasse', parentActive: null, ...patch })
const live = (patch: Partial<LiveFacts> = {}): LiveFacts => ({ working: false, sessions: 0, nextRunAt: null, ...patch })
const turn = (t: Partial<TaskFacts> = {}, l: Partial<LiveFacts> = {}) => turnOf(task(t), live(l), 'lasse', NOW)

describe('whose turn a task is', () => {
  it.each([
    ['an agent asked the owner', { waitingOn: { who: 'lasse', kind: 'question', why: 'Count the 07.11. booking?' } }, {}, { turn: 'needs_you', group: 'asked' }],
    ['a step waits for the owner\'s go', { delegate: 'atlas', checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'go' } }, {}, { turn: 'needs_you', group: 'asked' }],
    ['a run failed', { delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'stopped' } }, {}, { turn: 'needs_you', group: 'failed', reason: 'stopped' }],
    ['a routine repeats', { delegate: 'atlas', checkpoint: 'after' }, { nextRunAt: '2026-11-20T09:00:00Z', schedule: { crons: ['0 9 * * 1'] } }, { turn: 'agent_scheduled', group: 'routine' }],
    ['a mission checks back until its goal', { delegate: 'atlas', checkpoint: 'after' }, { nextRunAt: '2026-11-20T09:00:00Z', schedule: { at: '2026-11-20T09:00:00Z', by_session: 's1' } }, { turn: 'agent_scheduled', group: 'mission' }],
    ['it starts later', { delegate: 'atlas', checkpoint: 'after' }, { nextRunAt: '2026-11-20T09:00:00Z', schedule: { at: '2026-11-20T09:00:00Z' } }, { turn: 'agent_scheduled', group: 'at_time' }],
    ['an agent finished with checkpoint after', { delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'lasse', kind: 'review' } }, {}, { turn: 'review' }],
    ['a session works on it', { delegate: 'atlas', checkpoint: 'after' }, { working: true, sessions: 1 }, { turn: 'agent_working' }],
    ['a delegated task in progress with its session open but idle: the owner\'s move', { delegate: 'atlas', checkpoint: 'after' }, { sessions: 1 }, { turn: 'needs_you', group: 'nobody', reason: 'idle' }],
    ['someone else\'s delegated task in progress with an idle session here', { delegate: 'atlas', checkpoint: 'after', owner: 'dominik' }, { sessions: 1 }, { turn: 'waiting_on_others' }],
    ['a delegated task in progress whose session waits for its own subagents', { delegate: 'atlas', checkpoint: 'after' }, { working: true, sessions: 1 }, { turn: 'agent_working' }],
    ['a delegated task in progress that nothing runs', { delegate: 'atlas', checkpoint: 'after' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'stopped' }],
    ['someone else\'s delegated task in progress with no session here (B1)', { delegate: 'atlas', checkpoint: 'after', owner: 'dominik' }, {}, { turn: 'waiting_on_others' }],
    ['an unowned delegated task in progress that nothing runs', { delegate: 'atlas', checkpoint: 'after', owner: undefined }, {}, { turn: 'needs_you', group: 'nobody', reason: 'stopped' }],
    ['a customer has to answer', { delegate: 'atlas', waitingOn: { who: 'kim@acme', kind: 'outside' } }, {}, { turn: 'waiting_on_others' }],
    ['someone outside has to answer, the owner keeps an eye on it', { waitingOn: { who: 'lasse', kind: 'outside', why: 'Waiting for the supplier' } }, {}, { turn: 'waiting_on_others' }],
    ['someone outside has to answer and a job checks back', { delegate: 'atlas', checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'outside', why: 'Waiting for the supplier' } }, { nextRunAt: '2026-11-26T02:00:00Z', schedule: { crons: ['0 2 * * *'] } }, { turn: 'agent_scheduled', group: 'routine' }],
    ['a customer has to answer and a mission checks back', { delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'kim@acme', kind: 'outside' } }, { nextRunAt: '2026-11-26T02:00:00Z', schedule: { at: '2026-11-26T02:00:00Z', by_session: 's1' } }, { turn: 'agent_scheduled', group: 'mission' }],
    ['someone outside has to answer, delegated, nothing checks back', { delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'lasse', kind: 'outside' } }, {}, { turn: 'waiting_on_others' }],
    ['a member has to answer and a job checks back', { delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'dominik', kind: 'question' } }, { nextRunAt: '2026-11-26T02:00:00Z' }, { turn: 'waiting_on_others' }],
    ['a job starts the delegate at a time', { delegate: 'atlas', checkpoint: 'after' }, { nextRunAt: '2026-11-20T09:00:00Z' }, { turn: 'agent_scheduled', group: 'at_time' }],
    ['the runner will start it', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true }, {}, { turn: 'agent_scheduled', group: 'runner' }],
    ['it waits for a step it depends on', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'depends', stepId: 'pr', title: 'Open the PR', status: 'active', more: 0 } }, {}, { turn: 'agent_scheduled', group: 'blocked' }],
    ['the step it depends on was dropped', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'depends', stepId: 'pr', title: null, status: 'invalidated', more: 0 } }, {}, { turn: 'needs_you', group: 'nobody', reason: 'step_dropped' }],
    ['the runner is at its cap', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'cap', running: 5, max: 5, standalone: true } }, {}, { turn: 'agent_scheduled', group: 'blocked' }],
    ['its hand-over can still be undone', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'held' } }, {}, { turn: 'agent_scheduled', group: 'blocked' }],
    ['a session is open on it', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'busy' } }, {}, { turn: 'agent_scheduled', group: 'blocked' }],
    ['the runner finds its parent not active', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'parent', parentId: 'p', status: 'planned' } }, {}, { turn: 'needs_you', group: 'parent' }],
    ['it is in no project', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, runner: { kind: 'no_project', scope: 'global' } }, {}, { turn: 'needs_you', group: 'nobody', reason: 'no_project' }],
    ['another member\'s cockpit starts it', { delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true, owner: 'dominik', runner: { kind: 'other_member', owner: 'dominik' } }, {}, { turn: 'agent_scheduled', group: 'runner' }],
    ['delegated without a checkpoint', { delegate: 'atlas', status: 'planned' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'no_checkpoint' }],
    ['delegated but never handed over (v0.23: no request)', { delegate: 'atlas', checkpoint: 'after', status: 'planned' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'not_handed_over' }],
    ['a run on it went silent for over an hour', { delegate: 'atlas', checkpoint: 'after' }, { sessions: 1, stale: true }, { turn: 'agent_working', group: 'stale' }],
    ['a delegated step whose parent is not active', { delegate: 'atlas', checkpoint: 'after', status: 'planned', parentActive: false }, {}, { turn: 'needs_you', group: 'parent' }],
    ['delegated without a checkpoint, in progress', { delegate: 'atlas', status: 'active' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'no_checkpoint' }],
    ['the owner\'s own task', {}, {}, { turn: 'needs_you', group: 'own' }],
    ['a step of the owner\'s whose parent is not active', { parentActive: false }, {}, { turn: 'needs_you', group: 'parent' }],
    ['nobody owns it', { owner: undefined }, {}, { turn: 'needs_you', group: 'nobody', reason: 'no_owner' }],
    ['someone else owns it', { owner: 'dominik' }, {}, { turn: 'waiting_on_others' }],
  ] as const)('%s', (_label, t, l, expected) => {
    expect(turn(t as Partial<TaskFacts>, l as Partial<LiveFacts>)).toEqual(expected)
  })

  it('a review stays a review while a session is open on it', () => {
    expect(turn({ waitingOn: { who: 'lasse', kind: 'review' } }, { working: true })).toEqual({ turn: 'review' })
  })

  it('done for a day after it was resolved, then off the board; a dropped task is never on it', () => {
    expect(turn({ status: 'resolved', closedAt: '2026-11-19T01:00:00Z' })).toEqual({ turn: 'done' })
    expect(turn({ status: 'resolved', closedAt: '2026-11-18T09:00:00Z' })).toBeNull()
    expect(turn({ status: 'resolved' })).toBeNull()
    expect(turn({ status: 'invalidated', closedAt: '2026-11-19T09:00:00Z' })).toBeNull()
  })

  it('a parked wait parks the task for every viewer until its date; past it, the wait counts again (v0.23)', () => {
    const asked = { who: 'lasse', kind: 'question', why: 'Which list?' }
    expect(turn({ waitingOn: { ...asked, snoozed_until: '2026-11-20T00:00:00.000Z' } })).toEqual({ turn: 'parked' })
    expect(turnOf(task({ waitingOn: { ...asked, snoozed_until: 'open' } }), live(), 'dominik', NOW)).toEqual({ turn: 'parked' })
    expect(turn({ waitingOn: { ...asked, snoozed_until: '2026-11-19T09:00:00.000Z' } })).toEqual({ turn: 'needs_you', group: 'asked' })
    expect(coverageOf(task({ waitingOn: { ...asked, snoozed_until: '2026-11-20T00:00:00.000Z' } }), live(), 'lasse', NOW)).toEqual({ ok: true, how: 'parked', at: '2026-11-20T00:00:00.000Z' })
  })

  it('a run gone silent shows as stale while only someone outside has the next move', () => {
    expect(turn({ delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'lasse', kind: 'outside' } }, { sessions: 1, stale: true })).toEqual({ turn: 'agent_working', group: 'stale' })
  })

  it('reads a waiting_on written before kinds existed', () => {
    expect(waitKind({ who: 'lasse', why: 'review: result ready' })).toBe('review')
    expect(waitKind({ who: 'lasse', why: 'Which price list?' })).toBe('question')
    expect(waitKind({ who: 'lasse', kind: 'nonsense', why: 'x' })).toBe('question')
    expect(turn({ waitingOn: { who: 'lasse', why: 'review' } })).toEqual({ turn: 'review' })
  })
})

describe('coverage: does anything move an important task without the owner', () => {
  const cover = (t: Partial<TaskFacts> = {}, l: Partial<LiveFacts> = {}, steps = 0) => coverageOf(task(t), live(l), 'lasse', NOW, steps)

  it('is covered by a working session, a job\'s next run or the runner', () => {
    expect(cover({ delegate: 'atlas' }, { working: true })).toEqual({ ok: true, how: 'working' })
    expect(cover({ delegate: 'atlas' }, { nextRunAt: '2026-11-20T09:00:00Z' })).toEqual({ ok: true, how: 'at_time', at: '2026-11-20T09:00:00Z' })
    expect(cover({ delegate: 'atlas', waitingOn: { who: 'kim', kind: 'outside' } }, { nextRunAt: '2026-11-26T10:00:00Z' }))
      .toEqual({ ok: true, how: 'checks_back', at: '2026-11-26T10:00:00Z' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after', status: 'planned', requested: true })).toEqual({ ok: true, how: 'runner' })
    expect(cover({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'outside' } }, { nextRunAt: '2026-11-26T10:00:00Z' }))
      .toEqual({ ok: true, how: 'checks_back', at: '2026-11-26T10:00:00Z' })
  })

  it('never asks the owner to answer when someone outside has the next move', () => {
    expect(cover({ waitingOn: { who: 'lasse', kind: 'outside' } })).toEqual({ ok: false, group: 'nofollow' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'lasse', kind: 'outside' } })).toEqual({ ok: false, group: 'nofollow' })
  })

  it('names what has to happen when nothing will', () => {
    expect(cover({ waitingOn: { who: 'lasse', kind: 'question' } })).toEqual({ ok: false, group: 'ask' })
    expect(cover({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'review' } })).toEqual({ ok: false, group: 'review' })
    expect(cover({ waitingOn: { who: 'lasse', kind: 'stopped' } })).toEqual({ ok: false, group: 'stopped', reason: 'stopped' })
    expect(cover({ parentActive: false })).toEqual({ ok: false, group: 'blocked', reason: 'parent' })
    expect(cover({ status: 'planned' }, {}, 3)).toEqual({ ok: false, group: 'blocked', reason: 'steps_wait', steps: 3 })
    expect(cover({ waitingOn: { who: 'kim', kind: 'outside' } })).toEqual({ ok: false, group: 'nofollow' })
    expect(cover({ delegate: 'atlas', status: 'planned' })).toEqual({ ok: false, group: 'idle', reason: 'no_checkpoint' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after' })).toEqual({ ok: false, group: 'stopped', reason: 'stopped' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after' }, { sessions: 1 })).toEqual({ ok: false, group: 'stopped', reason: 'idle' })
    expect(cover({ owner: undefined })).toEqual({ ok: false, group: 'owner', reason: 'no_owner' })
    expect(cover({ due: '2026-11-24' })).toEqual({ ok: false, group: 'due' })
    expect(cover({ priority: 'high' })).toEqual({ ok: false, group: 'high' })
    expect(cover({})).toEqual({ ok: false, group: 'mine' })
  })
})

describe('Plan: importance and urgency', () => {
  const important = (t: Partial<TaskFacts>, l: Partial<LiveFacts> = {}) => isImportant(task(t), live(l), 'lasse', NOW)
  const urgency = (t: Partial<TaskFacts>, l: Partial<LiveFacts> = {}) => urgencyOf(task(t), live(l), 'lasse', NOW)

  it('counts a question, a stop, own work, a near due date or high priority as important', () => {
    expect(important({ waitingOn: { who: 'lasse', kind: 'question' } })).toBe(true)
    expect(important({ delegate: 'atlas', checkpoint: 'after', status: 'planned', due: '2026-11-25' })).toBe(true)
    expect(important({ delegate: 'atlas', checkpoint: 'after', status: 'planned', priority: 'high' })).toBe(true)
    expect(important({ delegate: 'atlas', checkpoint: 'after', status: 'planned', due: '2027-02-15' })).toBe(false)
    expect(important({ delegate: 'atlas', checkpoint: 'after' }, { sessions: 1 })).toBe(true)
    expect(important({ owner: 'dominik' })).toBe(false)
    expect(important({ waitingOn: { who: 'lasse', kind: 'outside' } })).toBe(false)
  })

  it('puts a question above a due date above priority', () => {
    const asked = urgency({ waitingOn: { who: 'lasse', kind: 'question' } })
    const dueSoon = urgency({ delegate: 'atlas', checkpoint: 'after', status: 'planned', due: '2026-11-20' })
    const high = urgency({ delegate: 'atlas', checkpoint: 'after', status: 'planned', priority: 'high' })
    const plain = urgency({ delegate: 'atlas', checkpoint: 'after', status: 'planned' })
    expect(asked).toBeGreaterThan(dueSoon)
    expect(dueSoon).toBeGreaterThan(high)
    expect(high).toBeGreaterThan(plain)
  })
})

describe('a shared space (B1)', () => {
  it('a delegated task in progress on the owner\'s machine is the owner\'s for everyone else, and stopped only for the owner', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after', owner: 'lasse' })
    expect(turnOf(t, live(), 'dominik', NOW)).toEqual({ turn: 'waiting_on_others' })
    expect(isImportant(t, live(), 'dominik', NOW)).toBe(false)
    expect(turnOf(t, live(), 'lasse', NOW)).toEqual({ turn: 'needs_you', group: 'nobody', reason: 'stopped' })
  })
})

describe('a step the person takes themselves (do, "Your move")', () => {
  // the viewer of these cases, who owns the task
  const turn = (t: Partial<TaskFacts> = {}, l: Partial<LiveFacts> = {}) => turnOf(task({ owner: 'dev-user', ...t }), live(l), 'dev-user', NOW)
  const doWait = { who: 'dev-user', kind: 'do', why: 'Sign the contract', due: '2026-11-20' }
  it('is the viewer\'s move, in Needs you as asked, even while the agent\'s check-back is coming up', () => {
    expect(waitKind(doWait)).toBe('do')
    expect(turn({ delegate: 'atlas', checkpoint: 'after', waitingOn: doWait })).toEqual({ turn: 'needs_you', group: 'asked' })
    expect(turn({ delegate: 'atlas', checkpoint: 'after', waitingOn: doWait }, { nextRunAt: '2026-11-21T09:00:00Z', schedule: { at: '2026-11-21T09:00:00Z', by_session: 's1' } }))
      .toEqual({ turn: 'needs_you', group: 'asked' })
    // a person's own reminder on a task nobody is delegated
    expect(turn({ waitingOn: { who: 'dev-user', kind: 'do', why: 'Call the bank' } })).toEqual({ turn: 'needs_you', group: 'asked' })
  })

  it('is someone else\'s move for anyone it does not name, and parks like any wait', () => {
    expect(turn({ delegate: 'atlas', checkpoint: 'after', waitingOn: { ...doWait, who: 'dominik' } })).toEqual({ turn: 'waiting_on_others' })
    expect(turn({ waitingOn: { ...doWait, snoozed_until: 'open' } })).toEqual({ turn: 'parked' })
  })
})
