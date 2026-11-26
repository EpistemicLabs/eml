import { describe, expect, it } from 'vitest'
import { recordEndTurn, saidReason, type RecordEndTurnDeps, type SaidTurn } from '../src/application/record-end-turn.js'
import { checkPrompt, deriveTurn, type EndTurn, type WakeEdit } from '../src/domain/turn-end.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')
const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }

function setup(patch: Partial<RecordEndTurnDeps> = {}, task: { open: boolean } | null = { open: true }) {
  const steps: string[] = []
  const kept: Array<{ sessionId: string; said: SaidTurn }> = []
  const checks: Array<{ sessionId: string; edit: WakeEdit; why: string }> = []
  const deps: RecordEndTurnDeps = {
    turnOf: async () => ({ ctx, task: task && { id: 't1', name: 'Refund from Acme', open: task.open } }),
    callTime: () => ({ now: NOW, zone: 'UTC' }),
    keep: (sessionId, said) => { steps.push('keep'); kept.push({ sessionId, said }) },
    turnWake: async (sessionId, wake) => {
      steps.push('wake')
      checks.push({ sessionId, edit: wake.edit, why: checkPrompt(wake.call, wake.turn.ctx) })
      return { problem: null, saved: null, nextRun: false }
    },
    ...patch,
  }
  return { deps, kept, checks, steps }
}

describe('recording an end_turn call', () => {
  it('keeps the call with its context and what was derived, then settles the task\'s wake-up', async () => {
    const { deps, kept, checks, steps } = setup()
    const call: EndTurn = { result: 'Draft ready', questions: ['Send it today?'] }
    const recorded = await recordEndTurn(deps, 's1', call)
    expect(kept).toEqual([{ sessionId: 's1', said: { call, ctx, derived: deriveTurn(call, ctx) } }])
    // No time: the wake-up goes only if this session set it.
    expect(checks).toEqual([{ sessionId: 's1', edit: { kind: 'clear', whose: 'own' }, why: checkPrompt(call, ctx) }])
    expect(steps).toEqual(['keep', 'wake'])
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

  it('does not look at the time of a step for the owner: it sets no wake-up and clears the task\'s, whoever set it', async () => {
    const { deps, kept, checks } = setup()
    const recorded = await recordEndTurn(deps, 's1', { result: 'Done', next: { who: 'lasse', what: 'review', when: '2020-01-01T10:00' } })
    expect(recorded.derived).toMatchObject({ status: 'review', checkAt: null })
    expect(kept).toHaveLength(1)
    expect(checks.map((c) => c.edit)).toEqual([{ kind: 'clear', whose: 'any' }])
  })

  it('sets the task\'s wake-up at next.when and names the time it was saved for', async () => {
    const saved = { at: Date.parse('2026-11-27T10:00:00Z'), zone: 'UTC' }
    const checks: WakeEdit[] = []
    const { deps } = setup({ turnWake: async (_id, wake) => { checks.push(wake.edit); return { problem: null, saved, nextRun: true } } })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2026-11-27T10:00' } })
    expect(checks).toEqual([{ kind: 'set', when: '2026-11-27T10:00' }])
    expect(recorded).toMatchObject({ missing: [], checkTime: saved })
    expect(recorded).not.toHaveProperty('checkProblem')
  })

  it('a wake-up that could not be set is named with what helps, and the call is kept all the same', async () => {
    const { deps, kept } = setup({ turnWake: async () => ({ problem: 'at: at most a year ahead', fix: 'time', saved: null, nextRun: false }) })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2028-01-01T10:00' } })
    expect(recorded.checkProblem).toBe('at: at most a year ahead')
    expect(recorded.checkFix).toBe('time')
    expect(recorded).not.toHaveProperty('checkTime')
    expect(kept).toHaveLength(1)
  })

  it('a problem with a wake-up the call did not ask for is not named', async () => {
    const recorded = await recordEndTurn(setup({ turnWake: async () => ({ problem: 'not removed', saved: null, nextRun: false }) }).deps, 's1', { result: 'Done' })
    expect(recorded).not.toHaveProperty('checkProblem')
  })

  it('works without a clock or a wake-up', async () => {
    const { deps, kept } = setup({ callTime: undefined, turnWake: undefined })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2999-01-01T10:00' } })
    expect(recorded).toEqual({ derived: { status: 'done', wait: null, checkAt: '2999-01-01T10:00' }, missing: [] })
    expect(kept).toHaveLength(1)
  })
})

describe('a task that has a next run', () => {
  const nextRun = async () => ({ problem: null, saved: null, nextRun: true })

  it('needs no time for a step for someone else: nothing is missing, and the call is kept again with the context that says so', async () => {
    const { deps, kept, steps } = setup({ turnWake: async () => { steps.push('wake'); return nextRun() } })
    const call: EndTurn = { result: 'Sent', next: { who: 'outside:acme', what: 'answer' } }
    const recorded = await recordEndTurn(deps, 's1', call)
    const withRun = { ...ctx, nextRun: true }
    expect(recorded).toEqual({ derived: deriveTurn(call, withRun), missing: [], nextRun: true })
    expect(recorded.derived.wait).toMatchObject({ who: 'acme', kind: 'outside' })
    expect(steps).toEqual(['keep', 'wake', 'keep'])
    expect(kept.map((k) => k.said.ctx)).toEqual([ctx, withRun])
    expect(kept[1].said.derived).toEqual(deriveTurn(call, withRun))
  })

  it('without a next run the same call still lacks its time', async () => {
    const recorded = await recordEndTurn(setup().deps, 's1', { result: 'Sent', next: { who: 'outside:acme', what: 'answer' } })
    expect(recorded.missing).toEqual(['when'])
    expect(recorded).not.toHaveProperty('nextRun')
  })
})

describe('what the lists show under a session', () => {
  it('is why it failed, else its first question, else where the task stands', () => {
    expect(saidReason({ result: 'r', failed: 'f', questions: ['q'] })).toBe('f')
    expect(saidReason({ result: 'r', questions: ['q1', 'q2'] })).toBe('q1')
    expect(saidReason({ result: 'r' })).toBe('r')
  })
})
