import { describe, expect, it } from 'vitest'
import { recordEndTurn, saidReason, type RecordEndTurnDeps, type SaidTurn } from '../src/application/record-end-turn.js'
import { deriveTurn, type EndTurn } from '../src/domain/turn-end.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')
const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }

function setup(patch: Partial<RecordEndTurnDeps> = {}, task: { open: boolean } | null = { open: true }) {
  const steps: string[] = []
  const kept: Array<{ sessionId: string; said: SaidTurn }> = []
  const checks: Array<{ sessionId: string; at: string | null }> = []
  const deps: RecordEndTurnDeps = {
    turnOf: async () => ({ ctx, task: task && { id: 't1', name: 'Refund from Acme', open: task.open } }),
    callTime: () => ({ now: NOW, zone: 'UTC' }),
    keep: (sessionId, said) => { steps.push('keep'); kept.push({ sessionId, said }) },
    turnCheck: async (sessionId, check) => { steps.push('check'); checks.push({ sessionId, at: check.at }); return null },
    checkSaved: () => null,
    ...patch,
  }
  return { deps, kept, checks, steps }
}

describe('recording an end_turn call', () => {
  it('keeps the call with its context and what was derived, then settles the check', async () => {
    const { deps, kept, checks, steps } = setup()
    const call: EndTurn = { result: 'Draft ready', questions: ['Send it today?'] }
    const recorded = await recordEndTurn(deps, 's1', call)
    expect(kept).toEqual([{ sessionId: 's1', said: { call, ctx, derived: deriveTurn(call, ctx) } }])
    expect(checks).toEqual([{ sessionId: 's1', at: null }])
    expect(steps).toEqual(['keep', 'check'])
    expect(recorded).toEqual({ derived: deriveTurn(call, ctx), missing: [] })
  })

  it('says what the call lacks: an open task without a next step, a step for someone else without a time', async () => {
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Half way' })).missing).toEqual(['next'])
    expect((await recordEndTurn(setup({}, { open: false }).deps, 's1', { result: 'Half way' })).missing).toEqual([])
    expect((await recordEndTurn(setup({}, null).deps, 's1', { result: 'Half way' })).missing).toEqual([])
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Sent', next: { who: 'outside:acme', what: 'answer' } })).missing).toEqual(['when'])
  })

  it('refuses a call whose check time has passed, and keeps nothing', async () => {
    const { deps, kept, checks } = setup()
    const call = { result: 'Sent', next: { who: 'me', what: 'look', when: '2020-01-01T10:00' } }
    await expect(recordEndTurn(deps, 's1', call)).rejects.toThrow('next.when "2020-01-01T10:00" has passed (read in UTC); name a time that is still to come')
    expect(kept).toEqual([])
    expect(checks).toEqual([])
  })

  it('does not look at the time of a step for the owner: it sets no check', async () => {
    const { deps, kept, checks } = setup()
    const recorded = await recordEndTurn(deps, 's1', { result: 'Done', next: { who: 'lasse', what: 'review', when: '2020-01-01T10:00' } })
    expect(recorded.derived).toMatchObject({ status: 'review', checkAt: null })
    expect(kept).toHaveLength(1)
    expect(checks).toEqual([{ sessionId: 's1', at: null }])
  })

  it('asks for the check at next.when and names the time it was saved for', async () => {
    const saved = { at: Date.parse('2026-11-27T10:00:00Z'), zone: 'UTC' }
    const { deps, checks } = setup({ checkSaved: () => saved })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2026-11-27T10:00' } })
    expect(checks).toEqual([{ sessionId: 's1', at: '2026-11-27T10:00' }])
    expect(recorded).toMatchObject({ missing: [], checkTime: saved })
    expect(recorded).not.toHaveProperty('checkProblem')
  })

  it('a check that could not be set is named, the call is kept all the same, and no saved time is read', async () => {
    const { deps, kept } = setup({ turnCheck: async () => 'at: at most a year ahead', checkSaved: () => { throw new Error('not read') } })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2028-01-01T10:00' } })
    expect(recorded.checkProblem).toBe('at: at most a year ahead')
    expect(recorded).not.toHaveProperty('checkTime')
    expect(kept).toHaveLength(1)
  })

  it('a problem with a check the call did not ask for is not named', async () => {
    const recorded = await recordEndTurn(setup({ turnCheck: async () => 'not removed' }).deps, 's1', { result: 'Done' })
    expect(recorded).not.toHaveProperty('checkProblem')
  })

  it('works without a clock, a check or a saved time', async () => {
    const { deps, kept } = setup({ callTime: undefined, turnCheck: undefined, checkSaved: undefined })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2999-01-01T10:00' } })
    expect(recorded).toEqual({ derived: { status: 'done', wait: null, checkAt: '2999-01-01T10:00' }, missing: [] })
    expect(kept).toHaveLength(1)
  })
})

describe('what the lists show under a session', () => {
  it('is why it failed, else its first question, else where the task stands', () => {
    expect(saidReason({ result: 'r', failed: 'f', questions: ['q'] })).toBe('f')
    expect(saidReason({ result: 'r', questions: ['q1', 'q2'] })).toBe('q1')
    expect(saidReason({ result: 'r' })).toBe('r')
  })
})
