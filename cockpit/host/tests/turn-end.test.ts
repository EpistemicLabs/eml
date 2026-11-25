import { describe, expect, it } from 'vitest'
import { parseHandoff } from '../src/domain/handoff.js'
import {
  BEFORE_IDLE_STOP, END_TURN_DESCRIPTION, END_TURN_TOOL, JOB_HEADER_STATUS, checkJobName, checkPrompt, deriveTurn, endTurnAnswer,
  fromHandoff, handoffBlock, missingOf, readEndTurn, reminder, turnEndRules, whoOf, type EndTurn, type Missing,
} from '../src/domain/turn-end.js'

const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'dominik', 'motti', 'atlas'] }
const WHEN = '2026-11-27T10:00'

describe('reading an end_turn call', () => {
  it('trims and drops empty fields', () => {
    const read = readEndTurn({ result: '  PR is open.  ', next: { who: ' @Dominik ', what: ' merges it ', when: '' }, questions: [' ', 'Ship it? '], failed: '', checked: ' CI ', claimed: '  ' })
    expect(read).toEqual({ ok: true, call: { result: 'PR is open.', next: { who: 'Dominik', what: 'merges it' }, questions: ['Ship it?'], checked: 'CI' } })
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

  it('knows whom a who names', () => {
    expect(whoOf('Lasse', ctx)).toEqual({ kind: 'owner', name: 'lasse' })
    expect(whoOf('user', ctx)).toEqual({ kind: 'owner', name: 'lasse' })
    expect(whoOf('@dominik', ctx)).toEqual({ kind: 'member', name: 'dominik' })
    for (const self of ['atlas', 'me', 'self', 'agent']) expect(whoOf(self, ctx)).toEqual({ kind: 'self', name: 'atlas' })
    expect(whoOf('outside:Acme GmbH', ctx)).toEqual({ kind: 'outside', name: 'Acme GmbH' })
    expect(whoOf('Acme', ctx)).toEqual({ kind: 'outside', name: 'Acme' })
  })
})

describe('what a call means (the first match wins)', () => {
  const base: EndTurn = { result: 'The export is fixed.' }

  it('1: failed stops the task for the owner, whatever else is set', () => {
    expect(deriveTurn({ ...base, failed: 'No access to the shop.', questions: ['Why?'], next: { who: 'lasse', what: 'x', when: WHEN } }, ctx))
      .toEqual({ status: 'failed', wait: { who: 'lasse', kind: 'stopped', why: 'No access to the shop.' }, checkAt: null })
  })

  it('2: questions are a question for the owner, a go when the checkpoint is before', () => {
    const call = { ...base, questions: ['Ship it today? It is ready.', 'Which price?'], next: { who: 'dominik', what: 'x', when: WHEN } }
    expect(deriveTurn(call, ctx)).toEqual({ status: 'question', wait: { who: 'lasse', kind: 'question', why: 'Ship it today? · Which price?' }, checkAt: WHEN })
    expect(deriveTurn({ ...base, questions: ['Go?'] }, { ...ctx, checkpoint: 'before' })).toEqual({ status: 'question', wait: { who: 'lasse', kind: 'go', why: 'Go?' }, checkAt: null })
  })

  it('3: next for the owner is a review', () => {
    expect(deriveTurn({ ...base, next: { who: 'lasse', what: 'Read the draft.' } }, ctx)).toEqual({ status: 'review', wait: { who: 'lasse', kind: 'review', why: 'Read the draft.' }, checkAt: null })
    expect(deriveTurn({ ...base, next: { who: 'lasse', what: '', when: WHEN } }, ctx)).toEqual({ status: 'review', wait: { who: 'lasse', kind: 'review', why: 'Review: The export is fixed.' }, checkAt: WHEN })
  })

  it('4: next for another member or agent waits on them', () => {
    expect(deriveTurn({ ...base, next: { who: 'Dominik', what: 'Merges the PR.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: { who: 'dominik', kind: 'review', why: 'Merges the PR.' }, checkAt: WHEN })
  })

  it('5: next for someone outside waits on them by name', () => {
    expect(deriveTurn({ ...base, next: { who: 'outside:Acme', what: 'Sends the file.' } }, ctx)).toEqual({ status: 'done', wait: { who: 'Acme', kind: 'outside', why: 'Sends the file.' }, checkAt: null })
    expect(deriveTurn({ ...base, next: { who: 'the supplier', what: 'Answers.' } }, ctx).wait).toEqual({ who: 'the supplier', kind: 'outside', why: 'Answers.' })
  })

  it('6: the agent\'s own next step with a time is a check and no wait', () => {
    expect(deriveTurn({ ...base, next: { who: 'me', what: 'Look at the deploy.', when: WHEN } }, ctx)).toEqual({ status: 'done', wait: null, checkAt: WHEN })
    expect(deriveTurn({ ...base, next: { who: 'atlas', what: 'Look at the deploy.', when: WHEN } }, ctx).checkAt).toBe(WHEN)
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
    expect(missingOf(null, { taskOpen: true })).toEqual(['call'])
    expect(missingOf({ result: 'x' }, { taskOpen: true })).toEqual(['next'])
    expect(missingOf({ result: 'x' }, { taskOpen: false })).toEqual([])
    expect(missingOf({ result: 'x', questions: ['Go?'] }, { taskOpen: true })).toEqual([])
    expect(missingOf({ result: 'x', failed: 'No access.' }, { taskOpen: true })).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'lasse', what: 'review' } }, { taskOpen: true })).toEqual([])
    expect(missingOf({ result: 'x', next: { who: 'me', what: 'check' } }, { taskOpen: true })).toEqual(['when'])
    expect(missingOf({ result: 'x', next: { who: 'atlas', what: 'check' } }, { taskOpen: true, agent: 'atlas' })).toEqual(['when'])
    expect(missingOf({ result: 'x', next: { who: 'atlas', what: 'check', when: WHEN } }, { taskOpen: true, agent: 'atlas' })).toEqual([])
  })
})

describe('the handoff block', () => {
  const call: EndTurn = {
    result: 'The PR is open and CI is green.',
    next: { who: 'dominik', what: 'Reviews and merges #12.', when: WHEN },
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
      'Next: [dominik] Reviews and merges #12. @ 2026-11-27T10:00',
      'Questions:',
      '- [lasse] Ship it before Friday?',
      '- [lasse] Which price goes on the page?',
    ].join('\n'))
    const handoff = parseHandoff(`All done.\n\n${block}`)
    expect(handoff?.forUser).toEqual(call.questions)
    expect(fromHandoff(handoff!, ctx)).toEqual(call)
  })

  it('round-trips a failed call, an alias and someone outside', () => {
    const failed: EndTurn = { result: 'Nothing was sent.', failed: 'The mailbox refused the login.', claimed: 'the address' }
    expect(fromHandoff(parseHandoff(handoffBlock(failed, ctx))!, ctx)).toEqual(failed)
    expect(handoffBlock({ result: 'Deploy runs.', next: { who: 'me', what: 'Look at it.', when: WHEN } }, ctx)).toContain('Next: [atlas] Look at it. @ 2026-11-27T10:00')
    const outside: EndTurn = { result: 'Mail sent.', next: { who: 'Acme GmbH', what: 'Answers the mail.' } }
    expect(fromHandoff(parseHandoff(handoffBlock(outside, ctx))!, ctx)).toEqual({ ...outside, next: { who: 'outside:Acme GmbH', what: 'Answers the mail.' } })
  })

  it('keeps a multi-line field on its line', () => {
    expect(handoffBlock({ result: 'One.\nTwo.' }, ctx)).toBe('### Handoff\nResult: One. Two.')
  })

  it('reads an untagged Next as no next', () => {
    const handoff = parseHandoff('### Handoff\nResult: Mockup is published.\nNext: Atlas confirms both deploys.')!
    expect(handoff.next).toBe('Atlas confirms both deploys.')
    expect(handoff.nextStep).toEqual({ who: null, what: 'Atlas confirms both deploys.', when: null })
    expect(fromHandoff(handoff, ctx)).toEqual({ result: 'Mockup is published.' })
  })

  it('reads a tagged Next a session wrote by hand', () => {
    const handoff = parseHandoff('## Handoff\n- **Result:** Draft is ready.\n- **Next:** [Lasse] reads the draft @ 2026-11-27 10:00\nQuestions:\n- [task] Which channel?')!
    expect(fromHandoff(handoff, ctx)).toEqual({ result: 'Draft is ready.', next: { who: 'lasse', what: 'reads the draft', when: '2026-11-27 10:00' } })
    expect(fromHandoff(parseHandoff('### Handoff\nNext: [me] mail info @ acme.example')!, ctx)).toEqual({ result: 'mail info @ acme.example', next: { who: 'atlas', what: 'mail info @ acme.example' } })
  })

  it('is no call when the block says nothing', () => {
    expect(fromHandoff(parseHandoff('### Handoff\nDecided: nothing')!, ctx)).toBeNull()
  })
})

describe('the texts', () => {
  const call: EndTurn = { result: 'x' }

  it('the reminder names each missing thing, and only that', () => {
    const parts: Record<Missing, string> = { call: 'without an end_turn call', reply: 'no visible reply', questions: 'does not ask them', next: 'no next step is recorded', when: 'without a time' }
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

  it('the tool answers with what it recorded, what is missing and the reply to come', () => {
    const answer = (c: EndTurn, opts?: Parameters<typeof endTurnAnswer>[2]) => endTurnAnswer(c, deriveTurn(c, ctx), opts)
    expect(answer({ ...call, questions: ['Go?'] })).toBe('Recorded: question for lasse. Now write your reply as visible text.')
    expect(answer({ ...call, questions: ['Go?', 'When?'] }, { replied: true })).toBe('Recorded: 2 questions for lasse.')
    expect(answer({ ...call, failed: 'No access.' }, { replied: true })).toBe('Recorded: failed, for lasse.')
    expect(answer({ ...call, next: { who: 'lasse', what: 'Read it.' } }, { replied: true })).toBe('Recorded: review for lasse.')
    expect(answer({ ...call, next: { who: 'dominik', what: 'Merge.', when: WHEN } }, { replied: true })).toBe('Recorded: waiting on dominik. Also: you look again at 2026-11-27T10:00.')
    expect(answer({ ...call, next: { who: 'outside:Acme', what: 'Answer.' } }, { replied: true })).toBe('Recorded: waiting on Acme (outside the space).')
    expect(answer({ ...call, next: { who: 'me', what: 'Check.', when: WHEN } }, { replied: true })).toBe('Recorded: you look again at 2026-11-27T10:00.')
    expect(answer(call, { replied: true })).toBe('Recorded: done, nobody has to act.')
    expect(answer(call, { missing: missingOf(call, { taskOpen: true }) })).toBe(`Recorded: done, nobody has to act. ${reminder(['next'])} Now write your reply as visible text.`)
  })

  it('end a turn with end_turn, never with session_status or the block', () => {
    const texts = [
      END_TURN_DESCRIPTION, JOB_HEADER_STATUS, BEFORE_IDLE_STOP, turnEndRules({ owner: 'lasse', tool: true }), turnEndRules({ owner: 'lasse' }),
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
    expect(END_TURN_DESCRIPTION).toContain('the user reads only that')
    expect(turnEndRules({ owner: 'lasse', tool: true })).toBe('## Ending a turn\nThe end_turn tool\'s description is the whole rule for ending a turn.')
  })

  it('a session without the tool gets the block with the same fields', () => {
    const rules = turnEndRules({ owner: 'lasse', tool: false })
    expect(rules).not.toContain('end_turn')
    expect(rules).toContain('### Handoff')
    expect(rules).toContain('Next: [<who>] <what they do> @ <when>')
    expect(rules).toContain('- [lasse] <what only the user can decide>')
    expect(rules).toContain('Write no block for a turn that is plain conversation.')
    expect(turnEndRules({ owner: 'lasse' })).toContain('Without that tool (a terminal), end your reply with this block when you stop')
  })

  it('the check wakes the session with what it waited for', () => {
    expect(checkJobName('Fix the export')).toBe('Check: Fix the export')
    expect(checkPrompt({ next: { who: 'me', what: 'Look at the deploy.' } }, ctx)).toBe('The check you set with end_turn is due. You planned: Look at the deploy. See where the task stands and act on it.')
    expect(checkPrompt({ next: { who: 'dominik', what: 'Merges the PR.' } }, ctx)).toBe('The check you set with end_turn is due. You waited on dominik: Merges the PR. See where the task stands and act on it.')
    expect(checkPrompt({ questions: ['Ship it?'] }, ctx)).toBe('The check you set with end_turn is due. You asked lasse: Ship it? See where the task stands and act on it.')
  })
})
