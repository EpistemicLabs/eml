import { describe, expect, it } from 'vitest'
import { parseHandoff } from '../src/domain/handoff.js'
import {
  BEFORE_IDLE_STOP, END_TURN_DESCRIPTION, END_TURN_TOOL, JOB_HEADER_STATUS, checkJobName, checkPrompt, deriveTurn, endTurnAnswer,
  fromHandoff, handoffBlock, missingOf, passedWhen, readEndTurn, reminder, resultOfTurn, shortQuestion, turnEndRules, whoOf, withoutOutside, statusAnswer, LEGACY_STATUS_DESCRIPTION, type EndTurn, type Missing,
} from '../src/domain/turn-end.js'

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
    expect(error({ result: 'x', next: { who: 'me', what: 'check', when: 'tomorrow' } })).toBe('Not recorded: next.when "tomorrow" is not a time. Write it like 2026-11-27T10:00. Call end_turn again.')
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
    expect(deriveTurn({ ...base, questions: ['Go?'] }, { ...ctx, checkpoint: 'before' })).toEqual({ status: 'question', wait: { who: 'kim', kind: 'go', why: 'Go?' }, checkAt: null })
  })

  it('3: next for the owner is a review', () => {
    expect(deriveTurn({ ...base, next: { who: 'kim', what: 'Read the draft.' } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Read the draft.' }, checkAt: null })
    expect(deriveTurn({ ...base, next: { who: 'kim', what: '', when: WHEN } }, ctx)).toEqual({ status: 'review', wait: { who: 'kim', kind: 'review', why: 'Review: The export is fixed.' }, checkAt: WHEN })
  })

  it('4: next for another member or agent waits on them like on someone outside: no review lands in their Inbox', () => {
    expect(deriveTurn({ ...base, next: { who: 'Sam', what: 'Merges the PR.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: { who: 'sam', kind: 'outside', why: 'Merges the PR.' }, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'echo', what: '', when: WHEN } }, ctx).wait).toEqual({ who: 'echo', kind: 'outside', why: 'The export is fixed.' })
  })

  it('5: next for someone outside waits on them by name', () => {
    expect(deriveTurn({ ...base, next: { who: 'outside:Acme', what: 'Sends the file.' } }, ctx)).toEqual({ status: 'done', wait: { who: 'Acme', kind: 'outside', why: 'Sends the file.' }, checkAt: null })
    expect(deriveTurn({ ...base, next: { who: 'the supplier', what: 'Answers.' } }, ctx).wait).toEqual({ who: 'the supplier', kind: 'outside', why: 'Answers.' })
  })

  it('6: the agent\'s own next step with a time is a check and no wait', () => {
    expect(deriveTurn({ ...base, next: { who: 'me', what: 'Look at the deploy.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: null, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'nova', what: 'Look at the deploy.', when: WHEN } }, ctx).checkAt).toBe(WHEN)
  })

  it('7: anything else is done, nobody waits', () => {
    const done = { status: 'done', wait: null, checkAt: null }
    expect(deriveTurn(base, ctx)).toEqual(done)
    expect(deriveTurn({ ...base, questions: [] }, ctx)).toEqual(done)
    expect(deriveTurn({ ...base, next: { who: 'self', what: 'Look again.' } }, ctx)).toEqual(done)
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

  it('a call without a next step on an open task is not answered as done', () => {
    const answer = endTurnAnswer(call, deriveTurn(call, ctx), { missing: missingOf(call, { taskOpen: true, ctx }) })
    expect(answer).toBe('Recorded: where the task stands, but no next step. The task is still open. Call end_turn with next, questions or failed. Now write your reply as visible text.')
    expect(answer).not.toContain('nobody has to act')
  })

  it('a next step for someone else without a time says the time is missing', () => {
    const WHEN_MISSING = "A next step for anyone but the user needs a time. Call end_turn with next.when: the time you look again, like 2026-11-27T10:00 in the user's time zone."
    const own: EndTurn = { ...call, next: { who: 'me', what: 'Check.' } }
    expect(endTurnAnswer(own, deriveTurn(own, ctx), { missing: missingOf(own, { taskOpen: true, ctx }) }))
      .toBe(`Recorded: where the task stands, but no next step. ${WHEN_MISSING} Now write your reply as visible text.`)
    const other: EndTurn = { ...call, next: { who: 'sam', what: 'Merge.' } }
    expect(endTurnAnswer(other, deriveTurn(other, ctx), { missing: missingOf(other, { taskOpen: true, ctx }) }))
      .toBe(`Recorded: waiting on sam. ${WHEN_MISSING} Now write your reply as visible text.`)
  })

  it('a check that could not be set is not answered as set: what was recorded, then that the check was not', () => {
    const CALL_AGAIN = "Call end_turn again with another next.when (the time you look again, like 2026-11-27T10:00 in the user's time zone)."
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
    expect(END_TURN_DESCRIPTION).toContain("when: the time you look again, like 2026-11-27T10:00 in the user's time zone; required unless who is the user.")
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
    expect(rules).toContain('required unless who is the user')
  })

  it('the check wakes the session with what it waited for', () => {
    expect(checkJobName('Fix the export')).toBe('Check: Fix the export')
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
