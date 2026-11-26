import { describe, expect, it } from 'vitest'
import { parseHandoff } from '../src/domain/handoff.js'
import {
  BEFORE_IDLE_STOP, END_TURN_DESCRIPTION, END_TURN_TOOL, endTurnDescription, JOB_HEADER_STATUS, checkPrompt, deriveTurn, endTurnAnswer,
  fromHandoff, handoffBlock, missingOf, passedWhen, readEndTurn, reminder, resultOfTurn, shortQuestion, turnEndRules, untilDoneRules, wakeEditOf, whoOf, withoutOutside, statusAnswer, LEGACY_STATUS_DESCRIPTION, type EndTurn, type Missing,
} from '../src/domain/turn-end.js'
import { zoneLabel } from '../src/domain/schedule.js'

const ctx = { owner: 'kim', agent: 'nova', members: ['kim', 'sam', 'echo', 'nova'] }
const WHEN = '2026-11-27T10:00'

describe('reading an end_turn call', () => {
  it('trims and drops empty fields', () => {
    const read = readEndTurn({ result: '  PR is open.  ', next: { who: ' @Sam ', what: ' merges it ', when: '' }, questions: [' ', 'Ship it? '], failed: '', checked: ' CI ', claimed: '  ' })
    expect(read).toEqual({ ok: true, call: { result: 'PR is open.', next: { who: 'Sam', what: 'merges it' }, questions: ['Ship it?'], checked: 'CI' } })
  })

  it('drops a next that names nothing', () => {
    expect(readEndTurn({ result: 'Done.', next: { who: ' ', what: '' } })).toEqual({ ok: true, call: { result: 'Done.' } })
  })

  it('refuses a call it cannot record and says why', () => {
    const error = (raw: unknown) => { const read = readEndTurn(raw); return read.ok ? '' : read.error }
    expect(error({ result: ' ' })).toContain('result is missing')
    expect(error(null)).toContain('result is missing')
    expect(error({ result: 'x', next: { what: 'review' } })).toContain('next.who is missing')
    expect(error({ result: 'x', next: { who: 'outside: ', what: 'answers' } })).toContain('without a name')
    expect(error({ result: 'x', next: { who: 'me', what: 'check', when: 'tomorrow' } })).toBe('Not recorded: next.when "tomorrow" is not a time. Write it as YYYY-MM-DDTHH:MM. Call end_turn again.')
    expect(readEndTurn({ result: 'x', next: { who: 'me', what: 'check', when: '2026-11-27T10:00:00+01:00' } }).ok).toBe(true)
  })

  it('refuses a time that has passed, read in the user\'s zone', () => {
    const at = { now: Date.parse('2026-11-27T09:00:00Z'), zone: 'Europe/Berlin' }
    const call = (when?: string) => ({ next: { who: 'me', what: 'check', ...(when ? { when } : {}) } })
    // 09:30 in Berlin is 08:30 UTC: half an hour ago.
    expect(passedWhen(call('2026-11-27T09:30'), at)).toBe('next.when "2026-11-27T09:30" has passed (read in Europe/Berlin); name a time that is still to come')
    // The moment itself has passed too.
    expect(passedWhen(call('2026-11-27T10:00'), at)).not.toBeNull()
    expect(passedWhen(call('2026-11-27T09:00:00Z'), at)).not.toBeNull()
    expect(passedWhen(call('2026-11-27T10:01'), at)).toBeNull()
    expect(passedWhen(call(), at)).toBeNull()
    expect(passedWhen({}, at)).toBeNull()
  })

  it('names the user\'s time zone where a session reads how to write a time', () => {
    const zone = 'Asia/Bangkok (UTC+7)'
    expect(endTurnDescription(zone)).toContain("when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone: Asia/Bangkok (UTC+7); required unless who is the user")
    expect(turnEndRules({ owner: 'kim', tool: true, zone })).toContain("Times: the user's time zone is Asia/Bangkok (UTC+7).")
    // A session without the tool reads it in the block's rules as well.
    expect(turnEndRules({ owner: 'kim', tool: false, zone })).toContain("when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone: Asia/Bangkok (UTC+7);")
    expect(turnEndRules({ owner: 'kim', tool: true })).not.toContain('Times:')
    expect(zoneLabel('Asia/Bangkok')).toBe(zone)
    expect(zoneLabel('Asia/Makassar')).toBe('Asia/Makassar (UTC+8)')
    expect(zoneLabel('Asia/Kolkata')).toBe('Asia/Kolkata (UTC+5:30)')
    expect(zoneLabel('UTC')).toBe('UTC (UTC)')
  })

  it('refuses a time that has passed in the user\'s zone while the process runs in UTC', () => {
    // 08:00 UTC is 15:00 in Bangkok: 14:59 there has passed, though 14:59 UTC has not.
    const at = { now: Date.parse('2026-11-25T08:00:00Z'), zone: 'Asia/Bangkok' }
    expect(passedWhen({ next: { who: 'me', what: 'check', when: '2026-11-25T14:59' } }, at)).toContain('(read in Asia/Bangkok)')
    expect(passedWhen({ next: { who: 'me', what: 'check', when: '2026-11-25T15:01' } }, at)).toBeNull()
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

describe('what a call means (the first match wins)', () => {
  const base: EndTurn = { result: 'The export is fixed.' }

  it('1: failed stops the task for the owner, whatever else is set', () => {
    expect(deriveTurn({ ...base, failed: 'No access to the shop.', questions: ['Why?'], next: { who: 'kim', what: 'x', when: WHEN } }, ctx))
      .toEqual({ status: 'failed', wait: { who: 'kim', kind: 'stopped', why: 'No access to the shop.' }, checkAt: null })
  })

  it('2: questions are a question for the owner, a go when the checkpoint is before', () => {
    const call = { ...base, questions: ['Ship it today? It is ready.', 'Which price?'], next: { who: 'sam', what: 'x', when: WHEN } }
    expect(deriveTurn(call, ctx)).toEqual({ status: 'question', wait: { who: 'kim', kind: 'question', why: 'Ship it today? · Which price?' }, checkAt: WHEN })
    // The check goes with a step that is not the owner's; questions with a step for the owner set none.
    expect(deriveTurn({ ...base, questions: ['Go?'], next: { who: 'me', what: 'x', when: WHEN } }, ctx).checkAt).toBe(WHEN)
    expect(deriveTurn({ ...base, questions: ['Go?'], next: { who: 'kim', what: 'x', when: WHEN } }, ctx).checkAt).toBeNull()
    expect(deriveTurn({ ...base, questions: ['Go?'] }, { ...ctx, checkpoint: 'before' })).toEqual({ status: 'question', wait: { who: 'kim', kind: 'go', why: 'Go?' }, checkAt: null })
  })

  it('3: next for the owner is a review', () => {
    expect(deriveTurn({ ...base, next: { who: 'kim', what: 'Read the draft.' } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Read the draft.' }, checkAt: null })
    // A hand-over sets no check, also with a time: the review has to be able to close the task.
    expect(deriveTurn({ ...base, next: { who: 'kim', what: '', when: WHEN } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Review: The export is fixed.' }, checkAt: null })
    expect(deriveTurn({ ...base, next: { who: 'user', what: 'Read it.', when: WHEN } }, ctx).checkAt).toBeNull()
  })

  it('4: next for another member or agent waits on them like on someone outside: no review lands in their Inbox', () => {
    expect(deriveTurn({ ...base, next: { who: 'Sam', what: 'Merges the PR.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: { who: 'sam', kind: 'outside', why: 'Merges the PR.' }, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'echo', what: '', when: WHEN } }, ctx).wait).toEqual({ who: 'echo', kind: 'outside', why: 'The export is fixed.' })
  })

  it('5: next for someone outside waits on them by name', () => {
    expect(deriveTurn({ ...base, next: { who: 'outside:Acme', what: 'Sends the file.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: { who: 'Acme', kind: 'outside', why: 'Sends the file.' }, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'the supplier', what: 'Answers.', when: WHEN } }, ctx).wait).toEqual({ who: 'the supplier', kind: 'outside', why: 'Answers.' })
  })

  it('6: the agent\'s own next step with a time is a check and no wait', () => {
    expect(deriveTurn({ ...base, next: { who: 'me', what: 'Look at the deploy.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: null, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'nova', what: 'Look at the deploy.', when: WHEN } }, ctx).checkAt).toBe(WHEN)
  })

  it('7: anything else is done, nobody waits', () => {
    const done = { status: 'done', wait: null, checkAt: null }
    expect(deriveTurn(base, ctx)).toEqual(done)
    expect(deriveTurn({ ...base, questions: [] }, ctx)).toEqual(done)
    // A step for anyone but the owner without the time the agent looks again is no next step: no wait, no check.
    for (const who of ['self', 'nova', 'sam', 'echo', 'outside:Acme', 'the supplier']) expect(deriveTurn({ ...base, next: { who, what: 'Look again.' } }, ctx), who).toEqual(done)
  })
})

describe('what a stop still lacks', () => {
  it('names the call, the next step or the time', () => {
    const open = { taskOpen: true, ctx }
    expect(missingOf(null, open)).toEqual(['call'])
    expect(missingOf({ result: 'x' }, open)).toEqual(['next'])
    expect(missingOf({ result: 'x' }, { taskOpen: false, ctx })).toEqual([])
    expect(missingOf({ result: 'x', questions: ['Go?'] }, open)).toEqual([])
    expect(missingOf({ result: 'x', failed: 'No access.' }, open)).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'kim', what: 'review' } }, open)).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'user', what: 'review' } }, open)).toEqual([])
  })

  it('asks for the time the agent looks again whenever the next step is not the owner\'s', () => {
    const open = { taskOpen: true, ctx }
    for (const who of ['me', 'nova', 'sam', 'echo', 'outside:Acme', 'the supplier']) {
      expect(missingOf({ result: 'x', next: { who, what: 'does it' } }, open), who).toEqual(['when'])
      expect(missingOf({ result: 'x', next: { who, what: 'does it', when: WHEN } }, open), who).toEqual([])
    }
    // Also on a closed task: the wait is written all the same.
    expect(missingOf({ result: 'x', next: { who: 'sam', what: 'does it' } }, { taskOpen: false, ctx })).toEqual(['when'])
    // A question goes to the owner, whoever next names.
    expect(missingOf({ result: 'x', questions: ['Go?'], next: { who: 'sam', what: 'does it' } }, open)).toEqual([])
  })

  it('asks for no time when the task has a next run from its schedule', () => {
    const run = { taskOpen: true, ctx, nextRun: true }
    for (const who of ['me', 'nova', 'sam', 'echo', 'outside:Acme']) {
      expect(missingOf({ result: 'x', next: { who, what: 'does it' } }, run), who).toEqual([])
      expect(missingOf({ result: 'x', next: { who, what: 'does it', when: WHEN } }, run), who).toEqual([])
      expect(missingOf({ result: 'x', next: { who, what: 'does it' } }, { ...run, nextRun: false }), who).toEqual(['when'])
    }
    // A next run stands for the time only: a stop without a call, and an open task without a next step, still lack theirs.
    expect(missingOf(null, run)).toEqual(['call'])
    expect(missingOf({ result: 'x' }, run)).toEqual(['next'])
    expect(missingOf({ result: 'x', next: { who: 'kim', what: 'review' } }, run)).toEqual([])
  })

  it('counts a step for someone else without a time when the task has a next run', () => {
    const run = { ...ctx, nextRun: true }
    expect(deriveTurn({ result: 'Sent.', next: { who: 'outside:Acme', what: 'Answers the offer.' } }, run))
      .toEqual({ status: 'done', wait: { who: 'Acme', kind: 'outside', why: 'Answers the offer.' }, checkAt: null })
    expect(deriveTurn({ result: 'Sent.', next: { who: 'sam', what: 'Merges it.' } }, run).wait).toEqual({ who: 'sam', kind: 'outside', why: 'Merges it.' })
    expect(deriveTurn({ result: 'Sent.', next: { who: 'me', what: 'Look again.' } }, run)).toEqual({ status: 'done', wait: null, checkAt: null })
    // Without a next run nothing would bring it back up: no next step.
    expect(deriveTurn({ result: 'Sent.', next: { who: 'outside:Acme', what: 'Answers the offer.' } }, ctx)).toEqual({ status: 'done', wait: null, checkAt: null })
    // A time is still taken, and a hand-over still is a review.
    expect(deriveTurn({ result: 'Sent.', next: { who: 'me', what: 'Look again.', when: WHEN } }, run).checkAt).toBe(WHEN)
    expect(deriveTurn({ result: 'Done.', next: { who: 'kim', what: 'Read it.' } }, run).status).toBe('review')
  })

  it('says what a turn\'s end does to the task\'s wake-up: a time sets it, a hand-over clears it, any other end clears only its own', () => {
    const edit = (call: EndTurn) => wakeEditOf(deriveTurn(call, ctx))
    expect(edit({ result: 'x', next: { who: 'me', what: 'look', when: WHEN } })).toEqual({ kind: 'set', when: WHEN })
    expect(edit({ result: 'x', next: { who: 'outside:Acme', what: 'answers', when: WHEN } })).toEqual({ kind: 'set', when: WHEN })
    expect(edit({ result: 'x', questions: ['Go?'], next: { who: 'me', what: 'look', when: WHEN } })).toEqual({ kind: 'set', when: WHEN })
    // A hand-over to the owner: whoever set the wake-up, a review is followed by no run. Its own time is not used.
    expect(edit({ result: 'x', next: { who: 'kim', what: 'read it' } })).toEqual({ kind: 'clear', whose: 'any' })
    expect(edit({ result: 'x', next: { who: 'user', what: 'read it', when: WHEN } })).toEqual({ kind: 'clear', whose: 'any' })
    // Every other end without a time leaves another session's wake-up alone.
    for (const call of [{ result: 'x' }, { result: 'x', next: { who: 'me', what: 'look' } }, { result: 'x', questions: ['Go?'] }, { result: 'x', failed: 'No access.' }]) {
      expect(edit(call), JSON.stringify(call)).toEqual({ kind: 'clear', whose: 'own' })
    }
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
    result: 'The PR is open and CI is green.',
    next: { who: 'sam', what: 'Reviews and merges #12.', when: WHEN },
    questions: ['Ship it before Friday?', 'Which price goes on the page?'],
    checked: 'CI, the page in the dev cockpit',
    claimed: 'the price list',
    decided: 'One call instead of two.',
  }

  it('renders a call and reads it back', () => {
    const block = handoffBlock(call, ctx)
    expect(block).toBe([
      '### Handoff',
      'Result: The PR is open and CI is green.',
      'Checked: CI, the page in the dev cockpit · Claimed: the price list',
      'Decided: One call instead of two.',
      'Next: [sam] Reviews and merges #12. @ 2026-11-27T10:00',
      'Questions:',
      '- [kim] Ship it before Friday?',
      '- [kim] Which price goes on the page?',
    ].join('\n'))
    const handoff = parseHandoff(`All done.\n\n${block}`)
    expect(handoff?.forUser).toEqual(call.questions)
    expect(fromHandoff(handoff!, ctx)).toEqual(call)
  })

  it('round-trips a failed call, an alias and someone outside', () => {
    const failed: EndTurn = { result: 'Nothing was sent.', failed: 'The mailbox refused the login.', claimed: 'the address' }
    expect(fromHandoff(parseHandoff(handoffBlock(failed, ctx))!, ctx)).toEqual(failed)
    expect(handoffBlock({ result: 'Deploy runs.', next: { who: 'me', what: 'Look at it.', when: WHEN } }, ctx)).toContain('Next: [nova] Look at it. @ 2026-11-27T10:00')
    const outside: EndTurn = { result: 'Mail sent.', next: { who: 'Acme GmbH', what: 'Answers the mail.' } }
    expect(fromHandoff(parseHandoff(handoffBlock(outside, ctx))!, ctx)).toEqual({ ...outside, next: { who: 'outside:Acme GmbH', what: 'Answers the mail.' } })
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

  it('reads a tagged Next a session wrote by hand', () => {
    const handoff = parseHandoff('## Handoff\n- **Result:** Draft is ready.\n- **Next:** [Kim] reads the draft @ 2026-11-27 10:00\nQuestions:\n- [task] Which channel?')!
    expect(fromHandoff(handoff, ctx)).toEqual({ result: 'Draft is ready.', next: { who: 'kim', what: 'reads the draft', when: '2026-11-27 10:00' } })
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

  it('ends the Questions list at the next label: a Failed or Claimed line after it is that field, not a question', () => {
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
  })

  it('is no call when the block says nothing', () => {
    expect(fromHandoff(parseHandoff('### Handoff\nDecided: nothing')!, ctx)).toBeNull()
  })
})

describe('the texts', () => {
  const call: EndTurn = { result: 'x' }

  it('the reminder names each missing thing, and only that', () => {
    const parts: Record<Missing, string> = { call: 'without an end_turn call', reply: 'No visible reply follows your call', questions: 'does not ask them', next: 'no next step is recorded', when: 'needs a time' }
    for (const one of Object.keys(parts) as Missing[]) {
      const text = reminder([one])
      for (const [other, part] of Object.entries(parts)) expect(text.includes(part), `${one} names ${other}`).toBe(other === one)
    }
    expect(reminder(['questions', 'reply'])).toBe(`${reminder(['reply'])} ${reminder(['questions'])}`)
    // Without a call, a next step cannot be missing from it.
    expect(reminder(['call', 'next'])).toBe(reminder(['call']))
    expect(reminder(['next'], { tool: false })).toBe(`${reminder(['next'])} Without the end_turn tool, end your reply with the Handoff block instead.`)
    expect(reminder(['reply'], { tool: false })).toBe(reminder(['reply']))
  })

  it('the tool answers with what it recorded, and always ends with the reply that comes after the call', () => {
    const answer = (c: EndTurn, opts?: Parameters<typeof endTurnAnswer>[2]) => endTurnAnswer(c, deriveTurn(c, ctx), opts)
    const REPLY = 'Now write your reply as visible text.'
    expect(answer({ ...call, questions: ['Go?'] })).toBe(`Recorded: question for kim. ${REPLY}`)
    expect(answer({ ...call, questions: ['Go?', 'When?'] })).toBe(`Recorded: 2 questions for kim. ${REPLY}`)
    expect(answer({ ...call, failed: 'No access.' })).toBe(`Recorded: failed, for kim. ${REPLY}`)
    expect(answer({ ...call, next: { who: 'kim', what: 'Read it.' } })).toBe(`Recorded: review for kim. ${REPLY}`)
    expect(answer({ ...call, next: { who: 'sam', what: 'Merge.', when: WHEN } })).toBe(`Recorded: waiting on sam. Also: you look again at 2026-11-27T10:00. ${REPLY}`)
    expect(answer({ ...call, next: { who: 'outside:Acme', what: 'Answer.', when: WHEN } })).toBe(`Recorded: waiting on Acme. Also: you look again at 2026-11-27T10:00. ${REPLY}`)
    expect(answer({ ...call, next: { who: 'me', what: 'Check.', when: WHEN } })).toBe(`Recorded: you look again at 2026-11-27T10:00. ${REPLY}`)
    expect(answer(call)).toBe(`Recorded: done, nobody has to act. ${REPLY}`)
  })

  it('a hand-over with a time is answered as a review, without a check', () => {
    const review: EndTurn = { ...call, next: { who: 'kim', what: 'Read it.', when: WHEN } }
    expect(endTurnAnswer(review, deriveTurn(review, ctx), { checkProblem: 'whatever' })).toBe('Recorded: review for kim. Now write your reply as visible text.')
  })

  it('a call without a next step on an open task is not answered as done', () => {
    const answer = endTurnAnswer(call, deriveTurn(call, ctx), { missing: missingOf(call, { taskOpen: true, ctx }) })
    expect(answer).toBe('Recorded: where the task stands, but no next step. The task is still open. Call end_turn with next, questions or failed. Now write your reply as visible text.')
    expect(answer).not.toContain('nobody has to act')
  })

  it('a next step for someone else without a time says the time is missing', () => {
    const WHEN_MISSING = "A next step for anyone but the user needs a time, and this task has no next run from its schedule. Call end_turn with next.when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone."
    const own: EndTurn = { ...call, next: { who: 'me', what: 'Check.' } }
    expect(endTurnAnswer(own, deriveTurn(own, ctx), { missing: missingOf(own, { taskOpen: true, ctx }) }))
      .toBe(`Recorded: where the task stands, but no next step. ${WHEN_MISSING} Now write your reply as visible text.`)
    // The same for every who that is not the user: nothing is waited on without the time.
    for (const who of ['sam', 'echo', 'outside:Acme']) {
      const other: EndTurn = { ...call, next: { who, what: 'Merge.' } }
      expect(endTurnAnswer(other, deriveTurn(other, ctx), { missing: missingOf(other, { taskOpen: true, ctx }) }), who)
        .toBe(`Recorded: where the task stands, but no next step. ${WHEN_MISSING} Now write your reply as visible text.`)
    }
  })

  it('a step without a time on a task with a next run is answered as brought back up by that run', () => {
    const run = { ...ctx, nextRun: true }
    const answer = (c: EndTurn) => endTurnAnswer(c, deriveTurn(c, run), { missing: missingOf(c, { taskOpen: true, ctx: run, nextRun: true }), nextRun: true })
    expect(answer({ ...call, next: { who: 'me', what: 'Check.' } })).toBe("Recorded: the task's next run brings it back up. Now write your reply as visible text.")
    expect(answer({ ...call, next: { who: 'outside:Acme', what: 'Answers.' } })).toBe("Recorded: waiting on Acme. Also: the task's next run brings it back up. Now write your reply as visible text.")
    // A time of its own is named as before; a hand-over and a call without a next step say nothing of the run.
    expect(answer({ ...call, next: { who: 'me', what: 'Check.', when: WHEN } })).toBe(`Recorded: you look again at ${WHEN}. Now write your reply as visible text.`)
    expect(answer({ ...call, next: { who: 'kim', what: 'Read it.' } })).toBe('Recorded: review for kim. Now write your reply as visible text.')
    expect(answer(call)).toBe('Recorded: where the task stands, but no next step. The task is still open. Call end_turn with next, questions or failed. Now write your reply as visible text.')
  })

  it('says what helps when a check could not be set: another time, the same call again, or nothing', () => {
    const own: EndTurn = { ...call, next: { who: 'me', what: 'Check.', when: WHEN } }
    const answer = (checkFix: 'time' | 'again' | 'none') => endTurnAnswer(own, deriveTurn(own, ctx), { checkProblem: 'the reason', checkFix })
    const opening = `Recorded: where the task stands, but no next step. The check at ${WHEN} was NOT set: the reason.`
    expect(answer('time')).toBe(`${opening} Call end_turn again with another next.when (the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone). Now write your reply as visible text.`)
    expect(answer('again')).toBe(`${opening} Call end_turn again. Now write your reply as visible text.`)
    expect(answer('none')).toBe(`${opening} Now write your reply as visible text.`)
  })

  it('a check that could not be set is not answered as set: what was recorded, then that the check was not', () => {
    const CALL_AGAIN = "Call end_turn again with another next.when (the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone)."
    const own: EndTurn = { ...call, next: { who: 'me', what: 'Check.', when: '2028-01-01T10:00' } }
    expect(endTurnAnswer(own, deriveTurn(own, ctx), { checkProblem: 'at: at most a year ahead' }))
      .toBe(`Recorded: where the task stands, but no next step. The check at 2028-01-01T10:00 was NOT set: at most a year ahead. ${CALL_AGAIN} Now write your reply as visible text.`)
    const other: EndTurn = { ...call, next: { who: 'sam', what: 'Merge.', when: '2028-01-01T10:00' } }
    const answer = endTurnAnswer(other, deriveTurn(other, ctx), { checkProblem: 'This space has 30 jobs already.' })
    expect(answer).toBe(`Recorded: waiting on sam. The check at 2028-01-01T10:00 was NOT set: This space has 30 jobs already. ${CALL_AGAIN} Now write your reply as visible text.`)
    expect(answer).not.toContain('you look again at 2028')
    // Without a time in the call there is no check to fail.
    expect(endTurnAnswer(call, deriveTurn(call, ctx), { checkProblem: 'whatever' })).toBe('Recorded: done, nobody has to act. Now write your reply as visible text.')
  })

  it('end a turn with end_turn, never with session_status or the block', () => {
    const texts = [
      END_TURN_DESCRIPTION, JOB_HEADER_STATUS, BEFORE_IDLE_STOP, turnEndRules({ owner: 'kim', tool: true }),
      ...(['call', 'reply', 'questions', 'next', 'when'] as Missing[]).map((m) => reminder([m])),
      endTurnAnswer(call, deriveTurn(call, ctx), { missing: ['next'] }),
      checkPrompt({ next: { who: 'me', what: 'Look at the deploy.' } }, ctx),
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
    expect(END_TURN_DESCRIPTION).toContain("when: the time you look again, as YYYY-MM-DDTHH:MM in the user's time zone; required unless who is the user, where it is not used, or the task has a next run from its schedule.")
    // An agent that waits for nothing has no reason to stop: said with the next step, once.
    expect(END_TURN_DESCRIPTION.split('\n')[3].endsWith('next is required while the task is open, unless questions or failed is set. If the next step is yours and you wait for nothing, do not end the turn: keep working.')).toBe(true)
    expect(END_TURN_DESCRIPTION.match(/keep working/g)).toHaveLength(1)
    expect(untilDoneRules('after')).toContain('- Not reached: name yourself as next, with the time you look again (when); a task that has a next run from its schedule needs no time. The cockpit wakes you then: a simple check needs no schedule tool call.')
    expect(turnEndRules({ owner: 'kim', agent: 'nova', tool: true })).toBe('## Ending a turn\nThe end_turn tool\'s description is the whole rule for ending a turn.\nHandles for who: the user is kim, you are nova.')
  })

  it('a session without the tool gets the block with the same fields', () => {
    const rules = turnEndRules({ owner: 'kim', tool: false })
    expect(rules).not.toContain('end_turn')
    expect(rules).toContain('### Handoff')
    expect(rules).toContain('Next: [<who>] <what they do> @ <when>')
    expect(rules).toContain('- [kim] <what only the user can decide>')
    expect(rules).toContain('Write no block for a turn that is plain conversation.')
    expect(rules).toContain('End your reply with this block when you stop')
    expect(rules).toContain('required unless who is the user, where it is not used')
  })

  it('the wake-up\'s reason tells the session what it waited for', () => {
    expect(checkPrompt({ next: { who: 'me', what: 'Look at the deploy.' } }, ctx)).toBe('The check you set with end_turn is due. You planned: Look at the deploy. See where the task stands and act on it.')
    expect(checkPrompt({ next: { who: 'sam', what: 'Merges the PR.' } }, ctx)).toBe('The check you set with end_turn is due. You waited on sam: Merges the PR. See where the task stands and act on it.')
    expect(checkPrompt({ questions: ['Ship it?'] }, ctx)).toBe('The check you set with end_turn is due. You asked kim: Ship it? See where the task stands and act on it.')
  })

  it('a question is kept up to its first question mark', () => {
    expect(shortQuestion('Close the task despite the open mails?You wanted it done. The brightline task was')).toBe('Close the task despite the open mails?')
  })

  it('the older status tool only points to end_turn and asks for the reply', () => {
    expect(LEGACY_STATUS_DESCRIPTION).toBe('The older form of end_turn, kept for sessions started before it. Use end_turn instead.')
    expect(statusAnswer('review')).toBe('Recorded: review. Now write your reply as visible text.')
  })
})
