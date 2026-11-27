import { describe, expect, it } from 'vitest'
import { parseHandoff } from '../src/domain/handoff.js'
import {
  BEFORE_IDLE_STOP, END_SCHEDULE_FIRST, END_TURN_DESCRIPTION, END_TURN_TOOL, FOR_REVIEW, endTurnDescription, JOB_HEADER_STATUS, askAndCheckOf, checkPrompt, deriveTurn, endTurnAnswer,
  fromHandoff, handoffBlock, missingOf, passedWhen, readAskLine, readCheckLine, readEndTurn, reminder, resultOfTurn, shortQuestion, storedDue, turnEndRules, untilDoneRules, wakeEditOf, whoOf, withoutOutside, statusAnswer, LEGACY_STATUS_DESCRIPTION, type EndTurn, type Missing, userZoneLine,
} from '../src/domain/turn-end.js'
import { zoneLabel } from '../src/domain/schedule.js'

const ctx = { owner: 'kim', agent: 'nova', members: ['kim', 'sam', 'echo', 'nova'] }
const WHEN = '2026-11-27T10:00'
const REPLY = 'Now write your reply as visible text.'
const prompt = (why: string) => `The check you set with end_turn is due. ${why} See where the task stands and act on it.`

describe('reading an end_turn call', () => {
  const error = (raw: unknown) => { const read = readEndTurn(raw); return read.ok ? '' : read.error }

  it('trims and drops empty fields', () => {
    const read = readEndTurn({ result: '  PR is open.  ', ask: { who: ' @Sam ', what: ' merges it ', kind: '', due: '' }, questions: [' ', 'Ship it? '], failed: '', checked: ' CI ', claimed: '  ' })
    expect(read).toEqual({ ok: true, call: { result: 'PR is open.', ask: { who: 'Sam', what: 'merges it' }, questions: ['Ship it?'], checked: 'CI' } })
  })

  it('reads an ask with its kind and due, and a check with its time and reason', () => {
    expect(readEndTurn({ result: 'Form ready.', ask: { who: 'kim', what: 'Sign it.', kind: ' DO ', due: '2026-11-28' }, check: { when: ` ${WHEN} `, why: ' Signed? ' } }))
      .toEqual({ ok: true, call: { result: 'Form ready.', ask: { who: 'kim', what: 'Sign it.', kind: 'do', due: '2026-11-28' }, check: { when: WHEN, why: 'Signed?' } } })
    expect(readEndTurn({ result: 'x', ask: { who: 'kim', what: 'Read it.', kind: 'review', due: '2026-11-28T17:00' } }))
      .toEqual({ ok: true, call: { result: 'x', ask: { who: 'kim', what: 'Read it.', kind: 'review', due: '2026-11-28T17:00' } } })
    // A check without a reason is kept; the cockpit writes one for it (askAndCheckOf).
    expect(readEndTurn({ result: 'x', check: { when: WHEN } })).toEqual({ ok: true, call: { result: 'x', check: { when: WHEN, why: '' } } })
    expect(readEndTurn({ result: 'x', check: { when: '2026-11-27T10:00:00+01:00', why: 'y' } }).ok).toBe(true)
  })

  it('reads check "none" as removing the wake-up, and a call without check as keeping it', () => {
    expect(readEndTurn({ result: 'x', check: 'none' })).toEqual({ ok: true, call: { result: 'x', check: 'none' } })
    expect(readEndTurn({ result: 'x', check: ' None ' })).toEqual({ ok: true, call: { result: 'x', check: 'none' } })
    expect(readEndTurn({ result: 'x' })).toEqual({ ok: true, call: { result: 'x' } })
  })

  it('drops an ask that names nothing', () => {
    expect(readEndTurn({ result: 'Done.', ask: { who: ' ', what: '' } })).toEqual({ ok: true, call: { result: 'Done.' } })
  })

  it('refuses a call it cannot record and says why', () => {
    expect(error({ result: ' ' })).toContain('result is missing')
    expect(error(null)).toContain('result is missing')
    expect(error({ result: 'x', ask: { what: 'review' } })).toBe('Not recorded: ask.who is missing (the handle of the user, or of another member or agent; outside:<name> for someone outside the space). Call end_turn again.')
    expect(error({ result: 'x', ask: { kind: 'do' } })).toContain('ask.who is missing')
    expect(error({ result: 'x', ask: { due: '2026-11-28' } })).toContain('ask.who is missing')
    expect(error({ result: 'x', ask: { who: 'outside: ', what: 'answers' } })).toContain('without a name')
    for (const self of ['me', 'self', 'agent', 'Myself', '@me']) {
      expect(error({ result: 'x', ask: { who: self, what: 'look again' } }), self).toBe('Not recorded: ask.who is yourself: a step of your own is a check (check.when), or keep working. Call end_turn again.')
    }
    expect(error({ result: 'x', ask: { who: 'kim', what: 'x', kind: 'later' } })).toBe('Not recorded: ask.kind "later" is neither do nor review. Call end_turn again.')
    expect(error({ result: 'x', ask: { who: 'kim', what: 'x', due: 'friday' } })).toBe('Not recorded: ask.due "friday" is not a date. Write it as YYYY-MM-DD or YYYY-MM-DDTHH:MM. Call end_turn again.')
    expect(error({ result: 'x', ask: { who: 'kim', what: 'x', due: '2026-13-45' } })).toContain('ask.due "2026-13-45" is not a date')
    expect(error({ result: 'x', check: { why: 'look' } })).toBe('Not recorded: check.when is missing (the time you look again, as YYYY-MM-DDTHH:MM in the user\'s time zone); to remove the wake-up, pass check "none". Call end_turn again.')
    expect(error({ result: 'x', check: { when: 'tomorrow', why: 'look' } })).toBe('Not recorded: check.when "tomorrow" is not a time. Write it as YYYY-MM-DDTHH:MM. Call end_turn again.')
  })

  it('keeps the older next of a session started before 0.25 when the call has neither ask nor check', () => {
    expect(readEndTurn({ result: 'x', next: { who: ' @Sam ', what: ' merges it ', when: '' } })).toEqual({ ok: true, call: { result: 'x', next: { who: 'Sam', what: 'merges it' } } })
    expect(readEndTurn({ result: 'x', next: { who: 'me', what: 'look', when: WHEN } })).toEqual({ ok: true, call: { result: 'x', next: { who: 'me', what: 'look', when: WHEN } } })
    expect(error({ result: 'x', next: { who: 'me', what: 'check', when: 'tomorrow' } })).toBe('Not recorded: next.when "tomorrow" is not a time. Write it as YYYY-MM-DDTHH:MM. Call end_turn again.')
    expect(error({ result: 'x', next: { who: 'outside: ', what: 'answers' } })).toContain('next.who is outside: without a name')
    // A next that names nobody is dropped.
    expect(readEndTurn({ result: 'Done.', next: { who: ' ', what: '' } })).toEqual({ ok: true, call: { result: 'Done.' } })
    // Next next to an ask or a check is not read: the new fields say it.
    expect(readEndTurn({ result: 'x', ask: { who: 'kim', what: 'Read it.' }, next: { who: 'sam', what: 'y', when: WHEN } })).toEqual({ ok: true, call: { result: 'x', ask: { who: 'kim', what: 'Read it.' } } })
    expect(readEndTurn({ result: 'x', check: 'none', next: { who: 'sam', what: 'y', when: 'bad' } })).toEqual({ ok: true, call: { result: 'x', check: 'none' } })
  })

  it('refuses a check that has passed, read in the user\'s zone', () => {
    const at = { now: Date.parse('2026-11-27T09:00:00Z'), zone: 'Europe/Berlin' }
    const check = (when: string) => ({ check: { when, why: 'look' } })
    // 09:30 in Berlin is 08:30 UTC: half an hour ago.
    expect(passedWhen(check('2026-11-27T09:30'), at, ctx)).toBe('check.when "2026-11-27T09:30" has passed (read in Europe/Berlin); name a time that is still to come')
    // The moment itself has passed too.
    expect(passedWhen(check('2026-11-27T10:00'), at, ctx)).not.toBeNull()
    expect(passedWhen(check('2026-11-27T09:00:00Z'), at, ctx)).not.toBeNull()
    expect(passedWhen(check('2026-11-27T10:01'), at, ctx)).toBeNull()
    expect(passedWhen({ check: 'none' }, at, ctx)).toBeNull()
    expect(passedWhen({}, at, ctx)).toBeNull()
    // An ask has no time to pass: its due may lie in the past.
    expect(passedWhen({ ask: { who: 'kim', what: 'sign', kind: 'do', due: '2020-01-01' } }, at, ctx)).toBeNull()
    // The older next: a passed time of its own, and one for the owner, which stands for a check too.
    expect(passedWhen({ next: { who: 'me', what: 'check', when: '2026-11-27T09:30' } }, at, ctx)).toBe('next.when "2026-11-27T09:30" has passed (read in Europe/Berlin); name a time that is still to come')
    expect(passedWhen({ next: { who: 'kim', what: 'sign', when: '2026-11-27T09:30' } }, at, ctx)).not.toBeNull()
    expect(passedWhen({ next: { who: 'kim', what: 'read it' } }, at, ctx)).toBeNull()
  })

  it('names the user\'s time zone where a session reads how to write a time', () => {
    const zone = 'Asia/Bangkok (UTC+7)'
    expect(endTurnDescription(zone)).toContain("when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone: Asia/Bangkok (UTC+7). why:")
    expect(turnEndRules({ owner: 'kim', tool: true, zone })).toContain("Times: the user's time zone is Asia/Bangkok (UTC+7).")
    expect(turnEndRules({ owner: 'kim', tool: true })).not.toContain('Times:')
    expect(zoneLabel('Asia/Bangkok')).toBe(zone)
    expect(zoneLabel('Asia/Makassar')).toBe('Asia/Makassar (UTC+8)')
    expect(zoneLabel('Asia/Kolkata')).toBe('Asia/Kolkata (UTC+5:30)')
    expect(zoneLabel('UTC')).toBe('UTC (UTC)')
  })

  it('refuses a check that has passed in the user\'s zone while the process runs in UTC', () => {
    // 08:00 UTC is 15:00 in Bangkok: 14:59 there has passed, though 14:59 UTC has not.
    const at = { now: Date.parse('2026-11-25T08:00:00Z'), zone: 'Asia/Bangkok' }
    expect(passedWhen({ check: { when: '2026-11-25T14:59', why: 'look' } }, at, ctx)).toContain('(read in Asia/Bangkok)')
    expect(passedWhen({ check: { when: '2026-11-25T15:01', why: 'look' } }, at, ctx)).toBeNull()
  })

  it('keeps a due as the task keeps it: a date as written, a date and time as the instant in the user\'s zone', () => {
    expect(storedDue('2026-11-28', 'Asia/Bangkok')).toBe('2026-11-28')
    expect(storedDue('2026-11-28T17:00', 'Asia/Bangkok')).toBe('2026-11-28T10:00:00.000Z')
    expect(storedDue('2026-11-28T17:00', 'UTC')).toBe('2026-11-28T17:00:00.000Z')
  })

  it('knows whom a who names', () => {
    expect(whoOf('Kim', ctx)).toEqual({ kind: 'owner', name: 'kim' })
    expect(whoOf('user', ctx)).toEqual({ kind: 'owner', name: 'kim' })
    expect(whoOf('@sam', ctx)).toEqual({ kind: 'member', name: 'sam' })
    for (const self of ['nova', 'me', 'self', 'agent']) expect(whoOf(self, ctx)).toEqual({ kind: 'self', name: 'nova' })
    expect(whoOf('outside:Acme GmbH', ctx)).toEqual({ kind: 'outside', name: 'Acme GmbH' })
    expect(whoOf('Acme', ctx)).toEqual({ kind: 'outside', name: 'Acme' })
    for (const alias of ['myself', 'Me']) expect(whoOf(alias, ctx).kind).toBe('self')
    expect(whoOf('owner', ctx).kind).toBe('owner')
  })

  it('reads a who without the mark of someone outside', () => {
    expect(withoutOutside('outside: Acme GmbH')).toBe('Acme GmbH')
    expect(withoutOutside('Outside:acme')).toBe('acme')
    expect(withoutOutside(' sam ')).toBe('sam')
  })
})

describe('the ask and the check a call stands for', () => {
  it('takes a call of 0.25 as it is, and gives a check without a reason the one the cockpit writes', () => {
    const ask = { who: 'kim', what: 'Sign it.', kind: 'do' as const }
    expect(askAndCheckOf({ ask, check: { when: WHEN, why: 'Signed?' } }, ctx)).toEqual({ ask, check: { when: WHEN, why: 'Signed?' } })
    expect(askAndCheckOf({ ask, check: { when: WHEN, why: '' } }, ctx)).toEqual({ ask, check: { when: WHEN, why: prompt('You asked kim to: Sign it.') } })
    expect(askAndCheckOf({ check: 'none' }, ctx)).toEqual({ check: 'none' })
    expect(askAndCheckOf({}, ctx)).toEqual({})
  })

  it('the older next for yourself with a time is a check, and without one nothing', () => {
    expect(askAndCheckOf({ next: { who: 'me', what: 'Look at the deploy.', when: WHEN } }, ctx)).toEqual({ check: { when: WHEN, why: prompt('You planned: Look at the deploy.') } })
    expect(askAndCheckOf({ next: { who: 'nova', what: 'Look at the deploy.', when: WHEN } }, ctx)).toEqual({ check: { when: WHEN, why: prompt('You planned: Look at the deploy.') } })
    expect(askAndCheckOf({ next: { who: 'me', what: 'Look at the deploy.' } }, ctx)).toEqual({})
  })

  it('the older next for the owner with a time is a do ask and a check: their step, and the agent looks again', () => {
    expect(askAndCheckOf({ next: { who: 'kim', what: 'Sign it.', when: WHEN } }, ctx))
      .toEqual({ ask: { who: 'kim', what: 'Sign it.', kind: 'do' }, check: { when: WHEN, why: prompt('You asked kim to: Sign it.') } })
    expect(askAndCheckOf({ next: { who: 'user', what: 'Sign it.', when: WHEN } }, ctx).ask).toEqual({ who: 'kim', what: 'Sign it.', kind: 'do' })
  })

  it('the older next for the owner without a time is a review ask', () => {
    expect(askAndCheckOf({ next: { who: 'kim', what: 'Read the draft.' } }, ctx)).toEqual({ ask: { who: 'kim', what: 'Read the draft.', kind: 'review' } })
  })

  it('the older next for anyone else is an ask on them as written, and a check when it has a time', () => {
    expect(askAndCheckOf({ next: { who: 'sam', what: 'Merges the PR.', when: WHEN } }, ctx))
      .toEqual({ ask: { who: 'sam', what: 'Merges the PR.' }, check: { when: WHEN, why: prompt('You waited on sam: Merges the PR.') } })
    expect(askAndCheckOf({ next: { who: 'outside:Acme', what: 'Answers.' } }, ctx)).toEqual({ ask: { who: 'outside:Acme', what: 'Answers.' } })
  })
})

describe('what a call means (the first match wins)', () => {
  const base: EndTurn = { result: 'The export is fixed.' }
  const keep = { kind: 'keep' }
  const setAt = (why: string) => ({ kind: 'set', when: WHEN, why })

  it('1: failed stops the task for the owner, whatever else is set, and keeps the call\'s wake-up edit', () => {
    expect(deriveTurn({ ...base, failed: 'No access to the shop.', questions: ['Why?'], ask: { who: 'kim', what: 'x' } }, ctx))
      .toEqual({ status: 'failed', wait: { who: 'kim', kind: 'stopped', why: 'No access to the shop.' }, wake: keep })
    expect(deriveTurn({ ...base, failed: 'No access.', check: { when: WHEN, why: 'Try again.' } }, ctx).wake).toEqual(setAt('Try again.'))
    expect(deriveTurn({ ...base, failed: 'No access.', check: 'none' }, ctx).wake).toEqual({ kind: 'remove' })
  })

  it('2: questions are a question for the owner, a go when the checkpoint is before, and keep the call\'s wake-up edit', () => {
    const call: EndTurn = { ...base, questions: ['Ship it today? It is ready.', 'Which price?'], check: { when: WHEN, why: 'Answered?' } }
    expect(deriveTurn(call, ctx)).toEqual({ status: 'question', wait: { who: 'kim', kind: 'question', why: 'Ship it today? · Which price?' }, wake: setAt('Answered?') })
    expect(deriveTurn({ ...base, questions: ['Go?'] }, ctx).wake).toEqual(keep)
    expect(deriveTurn({ ...base, questions: ['Go?'], check: 'none' }, ctx).wake).toEqual({ kind: 'remove' })
    expect(deriveTurn({ ...base, questions: ['Go?'] }, { ...ctx, checkpoint: 'before' })).toEqual({ status: 'question', wait: { who: 'kim', kind: 'go', why: 'Go?' }, wake: keep })
  })

  it('3: an ask for the owner of kind do is their move: a wait of kind do, and the wake-up is kept', () => {
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: 'Sign the form.', kind: 'do' } }, ctx))
      .toEqual({ status: 'review', wait: { who: 'kim', kind: 'do', why: 'Sign the form.' }, wake: keep })
    expect(deriveTurn({ ...base, ask: { who: 'user', what: '', kind: 'do', due: '2026-11-28' } }, ctx).wait).toEqual({ who: 'kim', kind: 'do', why: 'The export is fixed.', due: '2026-11-28' })
  })

  it('4: an ask for the owner without a kind, or of kind review, is a review', () => {
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: 'Read the draft.' } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Read the draft.' }, wake: keep })
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: '', kind: 'review' } }, ctx).wait).toEqual({ who: 'kim', kind: 'review', why: 'Review: The export is fixed.' })
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: 'Read it.', due: '2026-11-28T10:00:00.000Z' } }, ctx).wait).toMatchObject({ kind: 'review', due: '2026-11-28T10:00:00.000Z' })
  })

  it('5: an ask for the owner with a check sets the wake-up next to the wait; with check "none" it removes it', () => {
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: 'Sign it.', kind: 'do' }, check: { when: WHEN, why: 'Signed?' } }, ctx))
      .toEqual({ status: 'review', wait: { who: 'kim', kind: 'do', why: 'Sign it.' }, wake: setAt('Signed?') })
    expect(deriveTurn({ ...base, ask: { who: 'kim', what: 'Read it.' }, check: 'none' }, ctx))
      .toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Read it.' }, wake: { kind: 'remove' } })
  })

  it('6: an ask for another member or agent, or someone outside, is an outside wait only with a check or a next run', () => {
    expect(deriveTurn({ ...base, ask: { who: 'Sam', what: 'Merges the PR.' }, check: { when: WHEN, why: 'Merged?' } }, ctx))
      .toEqual({ status: 'done', wait: { who: 'sam', kind: 'outside', why: 'Merges the PR.' }, wake: setAt('Merged?') })
    expect(deriveTurn({ ...base, ask: { who: 'echo', what: '' }, check: { when: WHEN, why: 'x' } }, ctx).wait).toEqual({ who: 'echo', kind: 'outside', why: 'The export is fixed.' })
    expect(deriveTurn({ ...base, ask: { who: 'outside:Acme', what: 'Sends the file.' }, check: { when: WHEN, why: 'x' } }, ctx).wait).toEqual({ who: 'Acme', kind: 'outside', why: 'Sends the file.' })
    expect(deriveTurn({ ...base, ask: { who: 'the supplier', what: 'Answers.', due: '2026-11-30' } }, { ...ctx, nextRun: true }))
      .toEqual({ status: 'done', wait: { who: 'the supplier', kind: 'outside', why: 'Answers.', due: '2026-11-30' }, wake: keep })
    // Without either nothing would bring it back up: no wait. Check "none" brings nothing back up either.
    for (const call of [{ ...base, ask: { who: 'sam', what: 'Merges.' } }, { ...base, ask: { who: 'outside:Acme', what: 'Answers.' }, check: 'none' as const }]) {
      expect(deriveTurn(call, ctx).wait, JSON.stringify(call)).toBeNull()
      expect(deriveTurn(call, ctx).status).toBe('done')
    }
    // An ask that names the agent by its handle waits on nobody.
    expect(deriveTurn({ ...base, ask: { who: 'nova', what: 'Look.' }, check: { when: WHEN, why: 'x' } }, ctx)).toEqual({ status: 'done', wait: null, wake: setAt('x') })
  })

  it('7: a check alone sets the wake-up and nobody waits; nothing at all keeps it', () => {
    expect(deriveTurn({ ...base, check: { when: WHEN, why: 'Look at the deploy.' } }, ctx)).toEqual({ status: 'done', wait: null, wake: setAt('Look at the deploy.') })
    expect(deriveTurn({ ...base, check: 'none' }, ctx)).toEqual({ status: 'done', wait: null, wake: { kind: 'remove' } })
    expect(deriveTurn(base, ctx)).toEqual({ status: 'done', wait: null, wake: keep })
    expect(deriveTurn({ ...base, questions: [] }, ctx)).toEqual({ status: 'done', wait: null, wake: keep })
  })

  it('reads the older next as the ask and the check it stands for', () => {
    expect(deriveTurn({ ...base, next: { who: 'kim', what: 'Sign it.', when: WHEN } }, ctx))
      .toEqual({ status: 'review', wait: { who: 'kim', kind: 'do', why: 'Sign it.' }, wake: setAt(prompt('You asked kim to: Sign it.')) })
    expect(deriveTurn({ ...base, next: { who: 'kim', what: 'Read it.' } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Read it.' }, wake: keep })
    expect(deriveTurn({ ...base, next: { who: 'me', what: 'Look.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: null, wake: setAt(prompt('You planned: Look.')) })
    expect(deriveTurn({ ...base, next: { who: 'outside:Acme', what: 'Answers.', when: WHEN } }, ctx).wait).toEqual({ who: 'Acme', kind: 'outside', why: 'Answers.' })
    for (const who of ['self', 'nova', 'sam', 'outside:Acme']) expect(deriveTurn({ ...base, next: { who, what: 'Look again.' } }, ctx), who).toEqual({ status: 'done', wait: null, wake: keep })
  })

  it('the wake-up edit follows the check alone', () => {
    expect(wakeEditOf(undefined)).toEqual({ kind: 'keep' })
    expect(wakeEditOf('none')).toEqual({ kind: 'remove' })
    expect(wakeEditOf({ when: WHEN, why: 'x' })).toEqual({ kind: 'set', when: WHEN, why: 'x' })
  })
})

describe('what a stop still lacks', () => {
  const open = { taskOpen: true, ctx }

  it('names the call, who moves next, or the check', () => {
    expect(missingOf(null, open)).toEqual(['call'])
    expect(missingOf({ result: 'x' }, open)).toEqual(['next'])
    expect(missingOf({ result: 'x' }, { taskOpen: false, ctx })).toEqual([])
    expect(missingOf({ result: 'x', questions: ['Go?'] }, open)).toEqual([])
    expect(missingOf({ result: 'x', failed: 'No access.' }, open)).toEqual([])
    expect(missingOf({ result: 'x', ask: { who: 'kim', what: 'review' } }, open)).toEqual([])
    expect(missingOf({ result: 'x', ask: { who: 'user', what: 'sign', kind: 'do' } }, open)).toEqual([])
    expect(missingOf({ result: 'x', check: { when: WHEN, why: 'look' } }, open)).toEqual([])
    // Check "none" is no check: the open task still lacks who moves next.
    expect(missingOf({ result: 'x', check: 'none' }, open)).toEqual(['next'])
  })

  it('asks for a check whenever the ask is not the owner\'s', () => {
    for (const who of ['sam', 'echo', 'outside:Acme', 'the supplier']) {
      expect(missingOf({ result: 'x', ask: { who, what: 'does it' } }, open), who).toEqual(['when'])
      expect(missingOf({ result: 'x', ask: { who, what: 'does it' }, check: 'none' }, open), who).toEqual(['when'])
      expect(missingOf({ result: 'x', ask: { who, what: 'does it' }, check: { when: WHEN, why: 'y' } }, open), who).toEqual([])
    }
    // Also on a closed task: the wait is written all the same.
    expect(missingOf({ result: 'x', ask: { who: 'sam', what: 'does it' } }, { taskOpen: false, ctx })).toEqual(['when'])
    // A question goes to the owner, whoever the ask names.
    expect(missingOf({ result: 'x', questions: ['Go?'], ask: { who: 'sam', what: 'does it' } }, open)).toEqual([])
  })

  it('counts a next run, a kept wake-up included, as what brings the task back up', () => {
    const run = { taskOpen: true, ctx, nextRun: true }
    for (const who of ['sam', 'echo', 'outside:Acme']) {
      expect(missingOf({ result: 'x', ask: { who, what: 'does it' } }, run), who).toEqual([])
      expect(missingOf({ result: 'x', ask: { who, what: 'does it' } }, { ...run, nextRun: false }), who).toEqual(['when'])
    }
    // A call without an ask on a task that kept its wake-up (the cockpit's nextRun) lacks nothing.
    expect(missingOf({ result: 'x' }, run)).toEqual([])
    // A stop without a call still lacks its call.
    expect(missingOf(null, run)).toEqual(['call'])
  })

  it('reads the older next as the ask and the check it stands for', () => {
    expect(missingOf({ result: 'x', next: { who: 'me', what: 'look' } }, open)).toEqual(['next'])
    expect(missingOf({ result: 'x', next: { who: 'me', what: 'look', when: WHEN } }, open)).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'sam', what: 'does it' } }, open)).toEqual(['when'])
    expect(missingOf({ result: 'x', next: { who: 'sam', what: 'does it', when: WHEN } }, open)).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'kim', what: 'review' } }, open)).toEqual([])
  })

  it('keeps the call\'s result for the run, else the block\'s', () => {
    expect(resultOfTurn({ result: 'From the call.' }, { result: 'From the block.' })).toBe('From the call.')
    expect(resultOfTurn(null, { result: 'From the block.' })).toBe('From the block.')
    expect(resultOfTurn(undefined, { result: null })).toBeNull()
    expect(resultOfTurn(null, null)).toBeNull()
  })
})

describe('the handoff block', () => {
  const call: EndTurn = {
    result: 'The form is filled in and CI is green.',
    ask: { who: 'kim', what: 'Sign the form.', kind: 'do', due: '2026-11-28' },
    check: { when: WHEN, why: 'See whether it came back.' },
    questions: ['Ship it before Friday?', 'Which price goes on the page?'],
    checked: 'CI, the page in the dev cockpit',
    claimed: 'the price list',
    decided: 'One call instead of two.',
  }

  it('renders a call with its Ask and Check lines and reads it back', () => {
    const block = handoffBlock(call, ctx)
    expect(block).toBe([
      '### Handoff',
      'Result: The form is filled in and CI is green.',
      'Checked: CI, the page in the dev cockpit · Claimed: the price list',
      'Decided: One call instead of two.',
      'Ask: [kim] Sign the form. · do · due 2026-11-28',
      'Check: 2026-11-27T10:00 · See whether it came back.',
      'Questions:',
      '- [kim] Ship it before Friday?',
      '- [kim] Which price goes on the page?',
    ].join('\n'))
    const handoff = parseHandoff(`All done.\n\n${block}`)
    expect(handoff?.forUser).toEqual(call.questions)
    expect(handoff?.ask).toEqual(call.ask)
    expect(handoff?.check).toEqual(call.check)
    expect(fromHandoff(handoff!, ctx)).toEqual(call)
  })

  it('round-trips check "none", a failed call, an alias and someone outside', () => {
    const removed: EndTurn = { result: 'Done.', ask: { who: 'kim', what: 'Read it.' }, check: 'none' }
    expect(handoffBlock(removed, ctx)).toBe('### Handoff\nResult: Done.\nAsk: [kim] Read it.\nCheck: none')
    expect(fromHandoff(parseHandoff(handoffBlock(removed, ctx))!, ctx)).toEqual(removed)
    const failed: EndTurn = { result: 'Nothing was sent.', failed: 'The mailbox refused the login.', claimed: 'the address' }
    expect(fromHandoff(parseHandoff(handoffBlock(failed, ctx))!, ctx)).toEqual(failed)
    expect(handoffBlock({ result: 'Read it.', ask: { who: 'user', what: 'Read it.' } }, ctx)).toContain('Ask: [kim] Read it.')
    const outside: EndTurn = { result: 'Mail sent.', ask: { who: 'Acme GmbH', what: 'Answers the mail.' }, check: { when: WHEN, why: 'Answered?' } }
    expect(handoffBlock(outside, ctx)).toContain('Ask: [outside:Acme GmbH] Answers the mail.')
    expect(fromHandoff(parseHandoff(handoffBlock(outside, ctx))!, ctx)).toEqual({ ...outside, ask: { who: 'outside:Acme GmbH', what: 'Answers the mail.' } })
  })

  it('keeps the reason the agent wrote, not one the cockpit wrote for it', () => {
    expect(handoffBlock({ result: 'Deploy runs.', check: { when: WHEN, why: '' } }, ctx)).toBe('### Handoff\nResult: Deploy runs.\nCheck: 2026-11-27T10:00')
  })

  it('writes an older call\'s next as the ask and the check it stands for, never as a Next line', () => {
    expect(handoffBlock({ result: 'Deploy runs.', next: { who: 'me', what: 'Look at it.', when: WHEN } }, ctx)).toBe('### Handoff\nResult: Deploy runs.\nCheck: 2026-11-27T10:00')
    expect(handoffBlock({ result: 'Form ready.', next: { who: 'kim', what: 'Sign it.', when: WHEN } }, ctx)).toBe('### Handoff\nResult: Form ready.\nAsk: [kim] Sign it. · do\nCheck: 2026-11-27T10:00')
    expect(handoffBlock({ result: 'Draft ready.', next: { who: 'kim', what: 'Read it.' } }, ctx)).toBe('### Handoff\nResult: Draft ready.\nAsk: [kim] Read it. · review')
  })

  it('reads the Ask and Check lines on their own', () => {
    expect(readAskLine('[kim] Sign it · DO · due 2026-11-28T17:00')).toEqual({ who: 'kim', what: 'Sign it', kind: 'do', due: '2026-11-28T17:00' })
    // A due that is no date stays part of what.
    expect(readAskLine('[kim] Sign it · due friday')).toEqual({ who: 'kim', what: 'Sign it · due friday' })
    expect(readAskLine('Kim signs it')).toBeNull()
    expect(readAskLine('[the PR](https://example.com/pr/12) needs a review')).toBeNull()
    expect(readCheckLine('none')).toBe('none')
    expect(readCheckLine('None.')).toBe('none')
    expect(readCheckLine('2026-11-27 10:00 look again')).toEqual({ when: '2026-11-27 10:00', why: 'look again' })
    expect(readCheckLine('2026-11-27T10:00')).toEqual({ when: '2026-11-27T10:00', why: '' })
    expect(readCheckLine('tomorrow')).toBeNull()
  })

  it('reads an Ask without a [who] as no ask, and a Next next to an Ask or a Check not at all', () => {
    expect(fromHandoff(parseHandoff('### Handoff\nResult: Draft ready.\nAsk: Kim reads it')!, ctx)).toEqual({ result: 'Draft ready.' })
    const both = parseHandoff('### Handoff\nResult: Draft ready.\nAsk: [kim] Read it.\nNext: [sam] merge it @ 2026-11-27T10:00')!
    expect(fromHandoff(both, ctx)).toEqual({ result: 'Draft ready.', ask: { who: 'kim', what: 'Read it.' } })
    const checked = parseHandoff('### Handoff\nResult: Draft ready.\nCheck: 2026-11-27T10:00 · look\nNext: [sam] merge it')!
    expect(fromHandoff(checked, ctx)).toEqual({ result: 'Draft ready.', check: { when: WHEN, why: 'look' } })
  })

  it('keeps a multi-line field on its line', () => {
    expect(handoffBlock({ result: 'One.\nTwo.' }, ctx)).toBe('### Handoff\nResult: One. Two.')
  })

  it('reads an untagged Next as no next', () => {
    const handoff = parseHandoff('### Handoff\nResult: Mockup is published.\nNext: Nova confirms both deploys.')!
    expect(handoff.next).toBe('Nova confirms both deploys.')
    expect(handoff.nextStep).toEqual({ who: null, what: 'Nova confirms both deploys.', when: null })
    expect(fromHandoff(handoff, ctx)).toEqual({ result: 'Mockup is published.' })
  })

  it('reads a tagged Next a session started before 0.25 wrote', () => {
    const handoff = parseHandoff('## Handoff\n- **Result:** Draft is ready.\n- **Next:** [Kim] reads the draft @ 2026-11-27 10:00\nQuestions:\n- [task] Which channel?')!
    const read = fromHandoff(handoff, ctx)!
    expect(read).toEqual({ result: 'Draft is ready.', next: { who: 'kim', what: 'reads the draft', when: '2026-11-27 10:00' } })
    // It stands for a do ask and a check, as a call's next does.
    expect(deriveTurn(read, ctx)).toMatchObject({ status: 'review', wait: { who: 'kim', kind: 'do' }, wake: { kind: 'set', when: '2026-11-27 10:00' } })
    expect(fromHandoff(parseHandoff('### Handoff\nNext: [me] mail info @ acme.example')!, ctx)).toEqual({ result: 'mail info @ acme.example', next: { who: 'nova', what: 'mail info @ acme.example' } })
  })

  it('reads a markdown link at the start of a question or a Next as text, not as a tag', () => {
    const handoff = parseHandoff([
      '### Handoff',
      'Result: Draft is ready.',
      'Next: [the PR](https://example.com/pr/12) needs a review',
      'Questions:',
      '- [the draft](https://example.com/draft) reads well, send it?',
      '- [kim] [the offer](https://example.com/offer) too?',
    ].join('\n'))!
    expect(handoff.nextStep).toEqual({ who: null, what: '[the PR](https://example.com/pr/12) needs a review', when: null })
    expect(handoff.forUser).toEqual(['[the draft](https://example.com/draft) reads well, send it?', '[the offer](https://example.com/offer) too?'])
    // A Next that names nobody is no next step.
    expect(fromHandoff(handoff, ctx)?.next).toBeUndefined()
    // A tag before the link is one.
    expect(parseHandoff('### Handoff\nNext: [sam] [the PR](https://example.com/pr/12) needs a review')!.nextStep).toEqual({ who: 'sam', what: '[the PR](https://example.com/pr/12) needs a review', when: null })
  })

  it('ends the Questions list at the next label: a Failed, Claimed, Ask or Check line after it is that field, not a question', () => {
    const handoff = parseHandoff([
      '### Handoff',
      'Result: Nothing was sent.',
      'Questions:',
      '- [kim] Use the other mailbox?',
      'Failed: The mailbox refused the login.',
      '- Claimed: the address',
    ].join('\n'))!
    expect(handoff.forUser).toEqual(['Use the other mailbox?'])
    expect(handoff.failed).toBe('The mailbox refused the login.')
    expect(handoff.claimed).toBe('the address')
    expect(fromHandoff(handoff, ctx)).toEqual({ result: 'Nothing was sent.', questions: ['Use the other mailbox?'], failed: 'The mailbox refused the login.', claimed: 'the address' })
    const asked = parseHandoff('### Handoff\nResult: Ready.\nQuestions:\n- Which mailbox?\nAsk: [kim] Read it.\nCheck: none')!
    expect(asked.forUser).toEqual(['Which mailbox?'])
    expect(fromHandoff(asked, ctx)).toEqual({ result: 'Ready.', ask: { who: 'kim', what: 'Read it.' }, check: 'none', questions: ['Which mailbox?'] })
  })

  it('is no call when the block says nothing', () => {
    expect(fromHandoff(parseHandoff('### Handoff\nDecided: nothing')!, ctx)).toBeNull()
  })
})

describe('the texts', () => {
  const call: EndTurn = { result: 'x' }
  const answer = (c: EndTurn, opts?: Parameters<typeof endTurnAnswer>[2], context = ctx) => endTurnAnswer(c, deriveTurn(c, context), opts)

  it('the reminder names each missing thing, and only that', () => {
    const parts: Record<Missing, string> = { call: 'without an end_turn call', reply: 'No visible reply follows your call', questions: 'does not ask them', next: 'nothing says who moves next', when: 'needs something that brings the task back up' }
    for (const one of Object.keys(parts) as Missing[]) {
      const text = reminder([one])
      for (const [other, part] of Object.entries(parts)) expect(text.includes(part), `${one} names ${other}`).toBe(other === one)
    }
    expect(reminder(['questions', 'reply'])).toBe(`${reminder(['reply'])} ${reminder(['questions'])}`)
    // Without a call, who moves next cannot be missing from it.
    expect(reminder(['call', 'next'])).toBe(reminder(['call']))
    expect(reminder(['call', 'when'])).toBe(reminder(['call']))
    // A session without the tool is not told about a block any more (a terminal fallback session has no turn routing).
    expect(reminder(['next'], { tool: false })).toBe(reminder(['next']))
    // A session that gets the tool from an MCP server: the name the tool goes by there.
    const mcp = { mcpServer: 'cockpit' }
    expect(reminder(['next'], { tool: mcp })).toBe(`${reminder(['next'])} The tool is mcp__cockpit__end_turn, from the MCP server cockpit.`)
    expect(reminder(['reply'], { tool: mcp })).toBe(reminder(['reply']))
    expect(reminder(['next'], { tool: true })).toBe(reminder(['next']))
  })

  it('the tool answers with what it recorded, and always ends with the reply that comes after the call', () => {
    const check = { when: WHEN, why: 'look' }
    expect(answer({ ...call, questions: ['Go?'] })).toBe(`Recorded: question for kim. ${REPLY}`)
    expect(answer({ ...call, questions: ['Go?', 'When?'] })).toBe(`Recorded: 2 questions for kim. ${REPLY}`)
    expect(answer({ ...call, failed: 'No access.' })).toBe(`Recorded: failed, for kim. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'kim', what: 'Read it.' } })).toBe(`Recorded: review for kim. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'kim', what: 'Sign it.', kind: 'do' } })).toBe(`Recorded: kim's move. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'kim', what: 'Sign it.', kind: 'do' }, check })).toBe(`Recorded: kim's move. Also: you look again at ${WHEN}. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'kim', what: 'Read it.' }, check: 'none' })).toBe(`Recorded: review for kim. Also: the task's wake-up is removed. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'sam', what: 'Merge.' }, check })).toBe(`Recorded: waiting on sam. Also: you look again at ${WHEN}. ${REPLY}`)
    expect(answer({ ...call, ask: { who: 'outside:Acme', what: 'Answer.' }, check })).toBe(`Recorded: waiting on Acme. Also: you look again at ${WHEN}. ${REPLY}`)
    expect(answer({ ...call, check })).toBe(`Recorded: you look again at ${WHEN}. ${REPLY}`)
    expect(answer({ ...call, check: 'none' })).toBe(`Recorded: the task's wake-up is removed. ${REPLY}`)
    expect(answer(call)).toBe(`Recorded: done, nobody has to act. ${REPLY}`)
    expect(answer({ ...call, check }, { checkTime: { at: Date.parse('2026-11-27T03:00:00Z'), zone: 'Asia/Bangkok' } }))
      .toBe(`Recorded: you look again at ${WHEN} (Asia/Bangkok, 2026-11-27T03:00Z). ${REPLY}`)
  })

  it('ends with what the task holds after the call, after what it lacks and before the reply', () => {
    const state = 'The task now — Lifecycle: open. Asks: none. Check: none. Repeating: none. Next run: none.'
    expect(answer(call, { state })).toBe(`Recorded: done, nobody has to act. ${state} ${REPLY}`)
    expect(answer(call, { state, missing: ['next'] })).toBe(`Recorded: where the task stands, but nobody has a move. The task is still open. Call end_turn with an ask, a check, questions or failed. ${state} ${REPLY}`)
    expect(answer(call, { state: null })).toBe(`Recorded: done, nobody has to act. ${REPLY}`)
  })

  it('an ask for the owner without a check is answered as their move, and names no problem with a wake-up it kept', () => {
    const review: EndTurn = { ...call, ask: { who: 'kim', what: 'Read it.' } }
    expect(answer(review, { checkProblem: 'whatever' })).toBe(`Recorded: review for kim. ${REPLY}`)
  })

  it('a call without an ask on an open task is not answered as done', () => {
    const text = answer(call, { missing: missingOf(call, { taskOpen: true, ctx }) })
    expect(text).toBe(`Recorded: where the task stands, but nobody has a move. The task is still open. Call end_turn with an ask, a check, questions or failed. ${REPLY}`)
    expect(text).not.toContain('nobody has to act')
  })

  it('an ask for someone else without a check says the check is missing', () => {
    const WHEN_MISSING = "An ask for anyone but the user needs something that brings the task back up, and this task has no check and no next run from its schedule. Call end_turn with check.when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone."
    for (const who of ['sam', 'echo', 'outside:Acme']) {
      const other: EndTurn = { ...call, ask: { who, what: 'Merge.' } }
      expect(answer(other, { missing: missingOf(other, { taskOpen: true, ctx }) }), who)
        .toBe(`Recorded: where the task stands, but nobody has a move. ${WHEN_MISSING} ${REPLY}`)
    }
  })

  it('an ask for someone else on a task with a next run is answered as brought back up by that run', () => {
    const run = { ...ctx, nextRun: true }
    const withRun = (c: EndTurn) => answer(c, { missing: missingOf(c, { taskOpen: true, ctx: run, nextRun: true }), nextRun: true }, run)
    expect(withRun({ ...call, ask: { who: 'outside:Acme', what: 'Answers.' } })).toBe(`Recorded: waiting on Acme. Also: the task's next run brings it back up. ${REPLY}`)
    // A check of its own is named as before; an ask for the owner and a call without an ask say nothing of the run.
    expect(withRun({ ...call, check: { when: WHEN, why: 'look' } })).toBe(`Recorded: you look again at ${WHEN}. ${REPLY}`)
    expect(withRun({ ...call, ask: { who: 'kim', what: 'Read it.' } })).toBe(`Recorded: review for kim. ${REPLY}`)
    expect(withRun(call)).toBe(`Recorded: done, nobody has to act. ${REPLY}`)
  })

  it('says what helps when a check could not be set: another time, the same call again, or nothing', () => {
    const own: EndTurn = { ...call, check: { when: WHEN, why: 'look' } }
    const withFix = (checkFix: 'time' | 'again' | 'none') => answer(own, { checkProblem: 'the reason', checkFix })
    const opening = `Recorded: where the task stands, but nobody has a move. The check at ${WHEN} was NOT set: the reason.`
    expect(withFix('time')).toBe(`${opening} Call end_turn again with another check.when (the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone). ${REPLY}`)
    expect(withFix('again')).toBe(`${opening} Call end_turn again. ${REPLY}`)
    expect(withFix('none')).toBe(`${opening} ${REPLY}`)
  })

  it('a check that could not be set is not answered as set: what was recorded, then that the check was not', () => {
    const CALL_AGAIN = "Call end_turn again with another check.when (the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone)."
    const own: EndTurn = { ...call, check: { when: '2028-01-01T10:00', why: 'look' } }
    expect(answer(own, { checkProblem: 'at: at most a year ahead' }))
      .toBe(`Recorded: where the task stands, but nobody has a move. The check at 2028-01-01T10:00 was NOT set: at most a year ahead. ${CALL_AGAIN} ${REPLY}`)
    const other: EndTurn = { ...call, ask: { who: 'sam', what: 'Merge.' }, check: { when: '2028-01-01T10:00', why: 'look' } }
    const text = answer(other, { checkProblem: 'This space has 30 jobs already.' })
    expect(text).toBe(`Recorded: waiting on sam. The check at 2028-01-01T10:00 was NOT set: This space has 30 jobs already. ${CALL_AGAIN} ${REPLY}`)
    expect(text).not.toContain('you look again at 2028')
    // Without a check in the call there is no check to fail.
    expect(answer(call, { checkProblem: 'whatever' })).toBe(`Recorded: done, nobody has to act. ${REPLY}`)
  })

  it('a wake-up that could not be removed is said so, with the call to make again', () => {
    const text = answer({ ...call, check: 'none' }, { checkProblem: 'the brain does not answer' })
    expect(text).toContain('The wake-up was NOT removed: the brain does not answer. Call end_turn again.')
    expect(text.endsWith(REPLY)).toBe(true)
  })

  it('end a turn with end_turn, never with session_status or the block', () => {
    const texts = [
      END_TURN_DESCRIPTION, JOB_HEADER_STATUS, BEFORE_IDLE_STOP, turnEndRules({ owner: 'kim', tool: true }),
      ...(['call', 'reply', 'questions', 'next', 'when'] as Missing[]).map((m) => reminder([m])),
      endTurnAnswer(call, deriveTurn(call, ctx), { missing: ['next'] }),
      checkPrompt({ planned: 'Look at the deploy.' }, ctx),
    ]
    expect(END_TURN_TOOL).toBe('end_turn')
    for (const text of texts) {
      expect(text).not.toContain('session_status')
      // The block is named only as the way without the tool.
      const beforeFallback = text.split(/Without (?:the end_turn|that) tool/)[0]
      expect(beforeFallback).not.toMatch(/handoff/i)
    }
    for (const text of texts.filter((t) => t !== reminder(['reply']))) expect(text).toContain('end_turn')
    expect(END_TURN_DESCRIPTION).toContain('Make no call for a turn that is plain conversation.')
    expect(END_TURN_DESCRIPTION).toContain('Call it first, then write your reply once as visible text, as the last thing in the turn: the user reads only that, never the call or your thinking.')
    expect(END_TURN_DESCRIPTION).toContain("check: when you look again. when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone. why: what you will check then; you read it when the cockpit wakes you.")
    expect(END_TURN_DESCRIPTION).toContain('It replaces the task\'s wake-up. Leave check out to keep the wake-up the task has; "none" removes it. An ask never removes it: the user\'s move and your check-back stand side by side.')
    expect(END_TURN_DESCRIPTION).toContain('kind: for the user: do (a step they take themselves, outside this chat: sign, call, send, decide; their Inbox shows it as their move) or review (a result to look at; the default).')
    expect(END_TURN_DESCRIPTION).toContain('due: when the step is due, as YYYY-MM-DD or YYYY-MM-DDTHH:MM.')
    expect(END_TURN_DESCRIPTION.split('\n').at(-1)).toBe('The answer says what the task holds after the call: its asks, its check, its repeating times and its next run. Check it against what you meant.')
    // An agent that waits for nothing has no reason to stop: said with what an open task needs, once.
    expect(END_TURN_DESCRIPTION.split('\n')[5]).toBe('While the task is open, a call needs an ask, questions, failed or a check, unless the task has a next run from its schedule. If the next step is yours and you wait for nothing, do not end the turn: keep working.')
    expect(END_TURN_DESCRIPTION.match(/keep working/g)).toHaveLength(1)
    // The older next is no field of the tool any more.
    expect(END_TURN_DESCRIPTION).not.toMatch(/^next:|next\.(?:who|when)/m)
    expect(untilDoneRules('after')).toContain('- Not reached: set a check with the time you look again (check.when); a task that keeps a wake-up, or has a next run from its schedule, needs none. The cockpit wakes you then: a simple check needs no schedule tool call.')
    expect(untilDoneRules('after')).toContain(`- Reached: ${FOR_REVIEW}. Do not close it yourself.`)
    expect(untilDoneRules('after')).toContain('ask them for it (kind do) and keep your check')
    expect(FOR_REVIEW).toBe('hand the result over for review (an ask for the owner, kind review)')
    expect(END_SCHEDULE_FIRST).toBe(`end its repeating times first with the schedule tool (action finish), then ${FOR_REVIEW}; a wake-up needs no step of yours: it ends when the task closes`)
    expect(turnEndRules({ owner: 'kim', agent: 'nova', tool: true })).toBe('## Ending a turn\nThe end_turn tool\'s description is the whole rule for ending a turn.\nHandles for who: the user is kim, you are nova.')
  })

  it('a session that gets the tool from an MCP server reads the tool by its name there and its whole rule: its agent CLI may never load the description', () => {
    const rules = turnEndRules({ owner: 'kim', agent: 'nova', tool: { mcpServer: 'cockpit' }, zone: 'Asia/Bangkok (UTC+7)' })
    expect(rules.split('\n')).toEqual([
      '## Ending a turn',
      'End a turn with the end_turn tool: mcp__cockpit__end_turn, from the MCP server cockpit. This is its whole rule:',
      // The rule, word for word as the tool's description says it.
      ...endTurnDescription('Asia/Bangkok (UTC+7)').split('\n'),
      'A note on the task does not replace the call: only the call says whose move it is.',
      'Handles for who: the user is kim, you are nova.',
      userZoneLine('Asia/Bangkok (UTC+7)'),
    ])
    // No block: a session with the tool has one way to end a turn.
    expect(rules).not.toMatch(/handoff|block/i)
  })

  it('the wake-up\'s reason tells the session what it waited for', () => {
    expect(checkPrompt({ planned: 'Look at the deploy.' }, ctx)).toBe(prompt('You planned: Look at the deploy.'))
    expect(checkPrompt({ ask: { who: 'sam', what: 'Merges the PR.' } }, ctx)).toBe(prompt('You waited on sam: Merges the PR.'))
    expect(checkPrompt({ ask: { who: 'outside:Acme', what: '' } }, ctx)).toBe(prompt('You waited on Acme.'))
    expect(checkPrompt({ ask: { who: 'kim', what: 'Sign it.', kind: 'do' } }, ctx)).toBe(prompt('You asked kim to: Sign it.'))
    expect(checkPrompt({ ask: { who: 'user', what: '' } }, ctx)).toBe(prompt('You asked kim for a step.'))
    expect(checkPrompt({ questions: ['Ship it?'], ask: { who: 'sam', what: 'x' } }, ctx)).toBe(prompt('You asked kim: Ship it?'))
    expect(checkPrompt({}, ctx)).toBe('The check you set with end_turn is due. See where the task stands and act on it.')
  })

  it('a question is kept up to its first question mark', () => {
    expect(shortQuestion('Close the task despite the open mails?You wanted it done. The brightline task was')).toBe('Close the task despite the open mails?')
  })

  it('the older status tool only points to end_turn and asks for the reply', () => {
    expect(LEGACY_STATUS_DESCRIPTION).toBe('The older form of end_turn, kept for sessions started before it. Use end_turn instead.')
    expect(statusAnswer('review')).toBe('Recorded: review. Now write your reply as visible text.')
  })
})
