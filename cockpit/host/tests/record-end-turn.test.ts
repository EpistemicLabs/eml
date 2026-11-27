import { describe, expect, it } from 'vitest'
import { recordEndTurn, saidReason, type RecordEndTurnDeps, type SaidTurn } from '../src/application/record-end-turn.js'
import type { WakeSettled } from '../src/application/turn-wake.js'
import { formatInZone } from '../src/domain/schedule.js'
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
    // No check: the task's wake-up is kept, whoever set it.
    expect(checks).toEqual([{ sessionId: 's1', edit: { kind: 'keep' }, why: checkPrompt(call, ctx) }])
    expect(steps).toEqual(['keep', 'wake'])
    expect(recorded).toEqual({ derived: deriveTurn(call, ctx), missing: [] })
  })

  it('says what the call lacks: an open task without an ask or a check, an ask for someone else without a check', async () => {
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Half way' })).missing).toEqual(['next'])
    expect((await recordEndTurn(setup({}, { open: false }).deps, 's1', { result: 'Half way' })).missing).toEqual([])
    expect((await recordEndTurn(setup({}, null).deps, 's1', { result: 'Half way' })).missing).toEqual([])
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Sent', ask: { who: 'outside:acme', what: 'answer' } })).missing).toEqual(['when'])
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Sent', ask: { who: 'outside:acme', what: 'answer' }, check: { when: '2026-11-27T10:00', why: 'answered?' } })).missing).toEqual([])
    expect((await recordEndTurn(setup().deps, 's1', { result: 'Sent', next: { who: 'outside:acme', what: 'answer' } })).missing).toEqual(['when'])
  })

  it('refuses a call whose check time has passed, and keeps nothing', async () => {
    const { deps, kept, checks } = setup()
    await expect(recordEndTurn(deps, 's1', { result: 'Sent', check: { when: '2020-01-01T10:00', why: 'look' } })).rejects.toThrow('check.when "2020-01-01T10:00" has passed (read in UTC); name a time that is still to come')
    await expect(recordEndTurn(deps, 's1', { result: 'Sent', next: { who: 'me', what: 'look', when: '2020-01-01T10:00' } })).rejects.toThrow('next.when "2020-01-01T10:00" has passed (read in UTC); name a time that is still to come')
    // An ask for the owner with a passed check is refused too: the check is the agent's, whatever the ask.
    await expect(recordEndTurn(deps, 's1', { result: 'Sent', ask: { who: 'user', what: 'sign', kind: 'do' }, check: { when: '2020-01-01T10:00', why: 'look' } })).rejects.toThrow('has passed')
    expect(kept).toEqual([])
    expect(checks).toEqual([])
  })

  it('an ask for the owner without a check keeps the task\'s wake-up, whoever set it; check "none" removes it', async () => {
    const { deps, kept, checks } = setup()
    const recorded = await recordEndTurn(deps, 's1', { result: 'Done', ask: { who: 'user', what: 'review' } })
    expect(recorded.derived).toMatchObject({ status: 'review', wake: { kind: 'keep' } })
    await recordEndTurn(deps, 's1', { result: 'Form ready', ask: { who: 'user', what: 'sign it', kind: 'do' } })
    await recordEndTurn(deps, 's1', { result: 'Done', ask: { who: 'user', what: 'review' }, check: 'none' })
    expect(kept).toHaveLength(3)
    expect(checks.map((c) => c.edit)).toEqual([{ kind: 'keep' }, { kind: 'keep' }, { kind: 'remove' }])
  })

  it('sets the task\'s wake-up at check.when and names the time it was saved for', async () => {
    const saved = { at: Date.parse('2026-11-27T10:00:00Z'), zone: 'UTC' }
    const checks: WakeEdit[] = []
    const { deps } = setup({ turnWake: async (_id, wake) => { checks.push(wake.edit); return { problem: null, saved, nextRun: true } } })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', check: { when: '2026-11-27T10:00', why: 'look' } })
    expect(checks).toEqual([{ kind: 'set', when: '2026-11-27T10:00', why: 'look' }])
    expect(recorded).toMatchObject({ missing: [], checkTime: saved })
    expect(recorded).not.toHaveProperty('checkProblem')
  })

  it('a wake-up that could not be set is named with what helps, and the call is kept all the same', async () => {
    const { deps, kept } = setup({ turnWake: async () => ({ problem: 'at: at most a year ahead', fix: 'time', saved: null, nextRun: false }) })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', check: { when: '2028-01-01T10:00', why: 'look' } })
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
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', check: { when: '2999-01-01T10:00', why: 'look' } })
    expect(recorded).toEqual({ derived: { status: 'done', wait: null, wake: { kind: 'set', when: '2999-01-01T10:00', why: 'look' } }, missing: [] })
    expect(kept).toHaveLength(1)
  })

  it('keeps a due as the task keeps it: a date as written, a date and time as the instant in the user\'s zone', async () => {
    const asked = async (due: string) => {
      const { deps, kept } = setup({ callTime: () => ({ now: NOW, zone: 'Asia/Bangkok' }) })
      const recorded = await recordEndTurn(deps, 's1', { result: 'Form ready', ask: { who: 'user', what: 'sign it', kind: 'do', due } })
      return { recorded, call: kept[0].said.call }
    }
    const date = await asked('2026-11-28')
    expect(date.call.ask?.due).toBe('2026-11-28')
    expect(date.recorded.derived.wait).toEqual({ who: ctx.owner, kind: 'do', why: 'sign it', due: '2026-11-28' })
    // 17:00 in Bangkok is 10:00 UTC.
    const time = await asked('2026-11-28T17:00')
    expect(time.call.ask?.due).toBe('2026-11-28T10:00:00.000Z')
    expect(time.recorded.derived.wait).toMatchObject({ kind: 'do', due: '2026-11-28T10:00:00.000Z' })
  })
})

describe('what the task holds after the call', () => {
  const AT = '2026-11-27T03:00:00.000Z'
  const local = (at: string) => `${formatInZone(Date.parse(at), 'Asia/Bangkok')} (Asia/Bangkok)`
  const settled = (patch: Partial<WakeSettled> = {}): WakeSettled => ({
    problem: null, saved: null, nextRun: true, outcome: 'kept', zone: 'Asia/Bangkok',
    before: { at: AT, why: 'see whether Acme answered', by: 'atlas', by_session: 's0' },
    after: { at: AT, why: 'see whether Acme answered', by: 'atlas', by_session: 's0' },
    task: { status: 'active', waits: [] },
    ...patch,
  })

  it('ends the answer with the state: a do ask for the owner without a check keeps the agent\'s wake-up and says so', async () => {
    const { deps } = setup({ turnWake: async () => settled() })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Form ready', ask: { who: 'user', what: 'sign the form', kind: 'do', due: '2026-11-28' } })
    expect(recorded.state).toBe([
      'The task now — Lifecycle: open.',
      `Asks: ${ctx.owner}'s move: sign the form (due 2026-11-28).`,
      `Check: kept, atlas checks back ${local(AT)}.`,
      'Repeating: none.',
      `Next run: ${local(AT)}.`,
    ].join(' '))
    // The kept wake-up is a next run: nothing is missing.
    expect(recorded).toMatchObject({ missing: [], nextRun: true })
  })

  it('lists the task\'s other waits, and replaces this session\'s own with the call\'s', async () => {
    const waits = [
      { id: 'w1', who: ctx.owner, kind: 'review', why: 'Review: the other draft', session_id: 's9' },
      { id: 'w2', who: ctx.owner, kind: 'question', why: 'Old question?', session_id: 's1' },
    ]
    const { deps } = setup({ turnWake: async () => settled({ outcome: 'removed', after: null, nextRun: false, task: { status: 'active', waits } }) })
    const recorded = await recordEndTurn(deps, 's1', { result: 'Sent', ask: { who: 'user', what: 'read it' }, check: 'none' })
    expect(recorded.state).toBe(`The task now — Lifecycle: open. Asks: review for ${ctx.owner}: Review: the other draft; review for ${ctx.owner}: read it. Check: removed, no wake-up. Repeating: none. Next run: none.`)
  })

  it('has no state when the task could not be read', async () => {
    const recorded = await recordEndTurn(setup({ turnWake: async () => ({ problem: null, saved: null, nextRun: false }) }).deps, 's1', { result: 'Done' })
    expect(recorded).not.toHaveProperty('state')
  })
})

describe('a task that has a next run', () => {
  const nextRun = async () => ({ problem: null, saved: null, nextRun: true })

  it('needs no check for an ask for someone else: nothing is missing, and the call is kept again with the context that says so', async () => {
    const { deps, kept, steps } = setup({ turnWake: async () => { steps.push('wake'); return nextRun() } })
    const call: EndTurn = { result: 'Sent', ask: { who: 'outside:acme', what: 'answer' } }
    const recorded = await recordEndTurn(deps, 's1', call)
    const withRun = { ...ctx, nextRun: true }
    expect(recorded).toEqual({ derived: deriveTurn(call, withRun), missing: [], nextRun: true })
    expect(recorded.derived.wait).toMatchObject({ who: 'acme', kind: 'outside' })
    expect(steps).toEqual(['keep', 'wake', 'keep'])
    expect(kept.map((k) => k.said.ctx)).toEqual([ctx, withRun])
    expect(kept[1].said.derived).toEqual(deriveTurn(call, withRun))
  })

  it('without a next run the same call still lacks its check', async () => {
    const recorded = await recordEndTurn(setup().deps, 's1', { result: 'Sent', ask: { who: 'outside:acme', what: 'answer' } })
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
