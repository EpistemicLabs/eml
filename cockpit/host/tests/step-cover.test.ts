import { describe, it, expect } from 'vitest'
import { coverOf, stallOf, stepsSummary, STALL_MS, type StepFacts } from '../src/domain/step-cover.js'
import type { TurnResult } from '../src/domain/task-turn.js'

const NOW = Date.parse('2026-11-28T10:00:00Z')
const step = (turn: TurnResult, patch: Partial<StepFacts> = {}): StepFacts => ({ id: 's1', name: 'Check the legacy service', turn, nextRunAt: null, lastActivity: '2026-11-28T09:00:00Z', ...patch })

describe('what covers a step', () => {
  it.each([
    [{ turn: 'agent_working' }, 'working'],
    [{ turn: 'agent_working', group: 'stale' }, null],
    [{ turn: 'agent_scheduled', group: 'mission' }, 'checks_back'],
    [{ turn: 'agent_scheduled', group: 'at_time' }, 'checks_back'],
    [{ turn: 'agent_scheduled', group: 'runner' }, 'runner'],
    [{ turn: 'agent_scheduled', group: 'blocked' }, 'runner'],
    [{ turn: 'agent_scheduled', group: 'steps' }, 'steps'],
    [{ turn: 'waiting_on_others' }, 'waits'],
    [{ turn: 'parked' }, 'parked'],
    [{ turn: 'review' }, 'asked'],
    [{ turn: 'needs_you', group: 'asked' }, 'asked'],
    [{ turn: 'needs_you', group: 'failed', reason: 'stopped' }, 'asked'],
    [{ turn: 'needs_you', group: 'nobody', reason: 'idle' }, null],
    [{ turn: 'needs_you', group: 'own' }, null],
    [{ turn: 'needs_you', group: 'parent' }, null],
  ] as const)('%o → %s', (turn, how) => {
    expect(coverOf({ turn: turn as TurnResult })).toBe(how)
  })
})

describe('a stalled step', () => {
  const day = new Date(NOW - STALL_MS).toISOString()
  it('waits on someone with nothing coming that brings it back, for a day', () => {
    expect(stallOf(step({ turn: 'waiting_on_others' }, { lastActivity: day }), NOW)).toEqual({ stepId: 's1', name: 'Check the legacy service', since: day, why: 'idle' })
    expect(stallOf(step({ turn: 'waiting_on_others' }, { lastActivity: '2026-11-28T01:00:00Z' }), NOW)).toBeNull()
  })
  it('nobody is on it for a day', () => {
    expect(stallOf(step({ turn: 'needs_you', group: 'nobody', reason: 'stopped' }, { lastActivity: day }), NOW)?.why).toBe('idle')
  })
  it('is past its due date, unless an agent works on it', () => {
    expect(stallOf(step({ turn: 'agent_scheduled', group: 'mission' }, { due: '2026-11-27' }), NOW)).toMatchObject({ why: 'due', due: '2026-11-27' })
    expect(stallOf(step({ turn: 'agent_working' }, { due: '2026-11-27' }), NOW)).toBeNull()
    expect(stallOf(step({ turn: 'agent_scheduled', group: 'mission' }, { due: '2026-11-28' }), NOW)).toBeNull()
  })
  it('never stalls while a wake-up, the runner or a parked wait will start it, or the owner has a row on it', () => {
    for (const turn of [{ turn: 'agent_scheduled', group: 'mission' }, { turn: 'agent_scheduled', group: 'runner' }, { turn: 'parked' }, { turn: 'review' }, { turn: 'needs_you', group: 'asked' }] as TurnResult[]) {
      expect(stallOf(step(turn, { lastActivity: '2026-11-01T00:00:00Z' }), NOW)).toBeNull()
    }
  })
})

describe('the open steps of a main task', () => {
  it('lists the working ones first, and is covered when every step is', () => {
    const summary = stepsSummary([
      step({ turn: 'agent_scheduled', group: 'mission' }, { id: 'a', name: 'A', delegate: 'atlas', nextRunAt: '2026-12-04T03:00:00Z' }),
      step({ turn: 'agent_working' }, { id: 'b', name: 'B', delegate: 'atlas' }),
      step({ turn: 'waiting_on_others' }, { id: 'c', name: 'C', waitingOn: { who: 'outside:Kim' } }),
    ], NOW)!
    expect(summary.covered).toBe(true)
    expect(summary.stalls).toEqual([])
    expect(summary.open).toEqual([
      { id: 'b', name: 'B', how: 'working', who: 'atlas' },
      { id: 'a', name: 'A', how: 'checks_back', at: '2026-12-04T03:00:00Z', who: 'atlas' },
      { id: 'c', name: 'C', how: 'waits', who: 'outside:Kim' },
    ])
  })
  it('is not covered while one step has nobody on it or stalled', () => {
    expect(stepsSummary([step({ turn: 'agent_working' }), step({ turn: 'needs_you', group: 'nobody', reason: 'idle' }, { id: 's2' })], NOW)!.covered).toBe(false)
    const stalled = stepsSummary([step({ turn: 'waiting_on_others' }, { lastActivity: '2026-11-20T00:00:00Z' })], NOW)!
    expect(stalled.covered).toBe(false)
    expect(stalled.stalls).toHaveLength(1)
    expect(stalled.open[0].how).toBeNull()
  })
  it('is null without open steps', () => {
    expect(stepsSummary([], NOW)).toBeNull()
  })
})
