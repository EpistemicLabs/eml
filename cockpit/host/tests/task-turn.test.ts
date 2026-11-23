import { describe, it, expect } from 'vitest'
import { coverageOf, isImportant, turnOf, urgencyOf, waitKind, type LiveFacts, type TaskFacts } from '../src/domain/task-turn.js'

const NOW = Date.parse('2026-11-19T10:00:00Z')
const task = (patch: Partial<TaskFacts> = {}): TaskFacts => ({ status: 'active', owner: 'lasse', parentActive: null, depsResolved: true, ...patch })
const live = (patch: Partial<LiveFacts> = {}): LiveFacts => ({ working: false, sessions: 0, nextRunAt: null, runner: true, ...patch })
const turn = (t: Partial<TaskFacts> = {}, l: Partial<LiveFacts> = {}) => turnOf(task(t), live(l), 'lasse', NOW)

describe('whose turn a task is', () => {
  it.each([
    ['an agent asked the owner', { waitingOn: { who: 'lasse', kind: 'question', why: 'Count the 07.11. booking?' } }, {}, { turn: 'needs_you', group: 'asked' }],
    ['a step waits for the owner\'s go', { delegate: 'atlas', checkpoint: 'before', waitingOn: { who: 'lasse', kind: 'go' } }, {}, { turn: 'needs_you', group: 'asked' }],
    ['an agent stopped without a next step', { delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'stopped' } }, {}, { turn: 'needs_you', group: 'nobody', reason: 'stopped' }],
    ['an agent finished with checkpoint after', { delegate: 'atlas', checkpoint: 'after', waitingOn: { who: 'lasse', kind: 'review' } }, {}, { turn: 'review' }],
    ['a session works on it', { delegate: 'atlas', checkpoint: 'after' }, { working: true, sessions: 1 }, { turn: 'agent_working' }],
    ['a delegated task in progress with its session open between turns', { delegate: 'atlas', checkpoint: 'after' }, { sessions: 1 }, { turn: 'agent_working' }],
    ['a delegated task in progress that nothing runs', { delegate: 'atlas', checkpoint: 'after' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'stopped' }],
    ['a customer has to answer', { delegate: 'atlas', waitingOn: { who: 'kim@acme', kind: 'outside' } }, {}, { turn: 'waiting_on_others' }],
    ['a job starts the delegate at a time', { delegate: 'atlas', checkpoint: 'after' }, { nextRunAt: '2026-11-20T09:00:00Z' }, { turn: 'agent_scheduled', group: 'at_time' }],
    ['the runner will start it', { delegate: 'atlas', checkpoint: 'after', status: 'planned' }, {}, { turn: 'agent_scheduled', group: 'runner' }],
    ['it waits for the task it depends on', { delegate: 'atlas', checkpoint: 'after', status: 'planned', depsResolved: false }, {}, { turn: 'agent_scheduled', group: 'runner' }],
    ['delegated without a checkpoint', { delegate: 'atlas', status: 'planned' }, {}, { turn: 'needs_you', group: 'nobody', reason: 'no_checkpoint' }],
    ['delegated in a space without a runner', { delegate: 'atlas', checkpoint: 'after', status: 'planned' }, { runner: false }, { turn: 'needs_you', group: 'nobody', reason: 'no_runner' }],
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
    expect(cover({ delegate: 'atlas', checkpoint: 'after', status: 'planned' })).toEqual({ ok: true, how: 'runner' })
  })

  it('names what has to happen when nothing will', () => {
    expect(cover({ waitingOn: { who: 'lasse', kind: 'question' } })).toEqual({ ok: false, group: 'ask' })
    expect(cover({ delegate: 'atlas', waitingOn: { who: 'lasse', kind: 'review' } })).toEqual({ ok: false, group: 'review' })
    expect(cover({ waitingOn: { who: 'lasse', kind: 'stopped' } })).toEqual({ ok: false, group: 'stopped', reason: 'stopped' })
    expect(cover({ parentActive: false })).toEqual({ ok: false, group: 'blocked', reason: 'parent' })
    expect(cover({ status: 'planned' }, {}, 3)).toEqual({ ok: false, group: 'blocked', reason: 'steps_wait', steps: 3 })
    expect(cover({ waitingOn: { who: 'kim', kind: 'outside' } })).toEqual({ ok: false, group: 'nofollow' })
    expect(cover({ delegate: 'atlas', status: 'planned' })).toEqual({ ok: false, group: 'idle', reason: 'no_checkpoint' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after', status: 'planned' }, { runner: false })).toEqual({ ok: false, group: 'idle', reason: 'no_runner' })
    expect(cover({ delegate: 'atlas', checkpoint: 'after' })).toEqual({ ok: false, group: 'stopped', reason: 'stopped' })
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
    expect(important({ owner: 'dominik' })).toBe(false)
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
