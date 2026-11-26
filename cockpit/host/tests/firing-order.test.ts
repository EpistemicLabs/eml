import { describe, it, expect } from 'vitest'
import { ANSWER_WAITS, decideFiring, type Fired, type FiringSession } from '../src/domain/firing-order.js'

// The four-line order: what the cockpit does when a task comes due. The first line that applies decides:
// a. a session works → a time is skipped, a message goes to it (or the bridge retries);
// b. a session waits on an answer (question or go, not a review) → it continues;
// c. the wake-up is due → the session that set it, else a new one;
// d. a repeating time or a message → a new session.

const cron: Fired = { times: true, wake: null, message: false }
const wake = (bySession: string | null = 's-set'): Fired => ({ times: true, wake: { bySession }, message: false })
const message: Fired = { times: false, wake: null, message: true }
const manual = cron

// A session is linked to the task's record unless a test says otherwise: only the message tests care.
const session = (sessionId: string, patch: Partial<FiringSession> = {}): FiringSession => ({ sessionId, working: false, wait: null, wakeable: true, linked: true, ...patch })
const own = (sessionId: string, patch: Partial<FiringSession> = {}): FiringSession => session(sessionId, { linked: false, ...patch })
const decide = (fired: Fired, sessions: FiringSession[] = [], workingElsewhere = false) => decideFiring({ fired, sessions, workingElsewhere })

describe('line a: a session of the task is working', () => {
  it('skips a due time, whichever it is: a repeating time, the wake-up, both, a run by hand', () => {
    const working = [session('s1', { working: true })]
    for (const fired of [cron, wake(), wake('s1'), wake(null), manual]) expect(decide(fired, working)).toEqual({ kind: 'skip' })
  })

  it('skips a time while another member\'s session works on it elsewhere', () => {
    expect(decide(cron, [], true)).toEqual({ kind: 'skip' })
    expect(decide(wake('s-set'), [session('s-set')], true)).toEqual({ kind: 'skip' })
  })

  it('skips a time even when another session of the task waits on an answer or set the wake-up', () => {
    expect(decide(cron, [session('s1', { working: true }), session('s2', { wait: 'question' })])).toEqual({ kind: 'skip' })
    expect(decide(wake('s2'), [session('s1', { working: true }), session('s2')])).toEqual({ kind: 'skip' })
  })

  it('never skips a message: the working session gets it with its next turn', () => {
    expect(decide(message, [session('s1', { working: true })])).toEqual({ kind: 'deliver', sessionId: 's1' })
  })

  it('gives a message to the working session, not to one that waits on an answer', () => {
    expect(decide(message, [session('s2', { wait: 'question' }), session('s1', { working: true })])).toEqual({ kind: 'deliver', sessionId: 's1' })
  })

  it('gives a message to the first working session that can take it', () => {
    const sessions = [session('s1', { working: true, wakeable: false }), session('s2', { working: true }), session('s3', { working: true })]
    expect(decide(message, sessions)).toEqual({ kind: 'deliver', sessionId: 's2' })
  })

  it('asks the bridge to retry a message no working session here can take', () => {
    expect(decide(message, [session('s1', { working: true, wakeable: false })])).toEqual({ kind: 'retry' })
    // the work is on another cockpit: nothing here takes it, and nothing starts beside it
    expect(decide(message, [], true)).toEqual({ kind: 'retry' })
    expect(decide(message, [session('s2', { wait: 'question' })], true)).toEqual({ kind: 'retry' })
  })

  it('never answers retry for a time, and never skips a message', () => {
    const lists: FiringSession[][] = [[], [session('s1', { working: true })], [session('s1', { working: true, wakeable: false })], [session('s1', { wait: 'go' })], [session('s1', { wakeable: false })]]
    for (const sessions of lists) for (const elsewhere of [false, true]) {
      for (const fired of [cron, wake(), wake(null)]) expect(decide(fired, sessions, elsewhere).kind).not.toBe('retry')
      expect(decide(message, sessions, elsewhere).kind).not.toBe('skip')
    }
  })

  it('a firing that names a time and a message is never skipped either', () => {
    const both: Fired = { times: true, wake: null, message: true }
    expect(decide(both, [session('s1', { working: true })])).toEqual({ kind: 'deliver', sessionId: 's1' })
    expect(decide(both, [], true)).toEqual({ kind: 'retry' })
  })
})

describe('line b: a session of the task waits on an answer', () => {
  it('names the wait kinds that count: a question and a plan waiting for its go', () => {
    expect(ANSWER_WAITS).toEqual(['question', 'go'])
  })

  it('continues the session that asked a question or waits for the go, whatever fired', () => {
    for (const wait of ['question', 'go']) {
      for (const fired of [cron, wake(), wake(null), message, manual]) {
        expect(decide(fired, [session('s1', { wait })])).toEqual({ kind: 'resume', sessionId: 's1', line: 'waiting' })
      }
    }
  })

  it('does not count a review: a repeating time starts a new session beside it', () => {
    expect(decide(cron, [session('s1', { wait: 'review' })])).toEqual({ kind: 'start' })
    expect(decide(message, [session('s1', { wait: 'review' })])).toEqual({ kind: 'start' })
  })

  it('does not count a stopped session, one waiting on someone outside, or a wait without a kind it knows', () => {
    for (const wait of ['stopped', 'outside', 'something', null]) expect(decide(cron, [session('s1', { wait })])).toEqual({ kind: 'start' })
  })

  it('prefers the waiting session over the one that set the wake-up', () => {
    expect(decide(wake('s-set'), [session('s-set'), session('s1', { wait: 'question' })])).toEqual({ kind: 'resume', sessionId: 's1', line: 'waiting' })
  })

  it('takes a question before a go, then the order the caller gave', () => {
    expect(decide(cron, [session('s1', { wait: 'go' }), session('s2', { wait: 'question' })])).toEqual({ kind: 'resume', sessionId: 's2', line: 'waiting' })
    expect(decide(cron, [session('s1', { wait: 'question' }), session('s2', { wait: 'question' })])).toEqual({ kind: 'resume', sessionId: 's1', line: 'waiting' })
  })

  it('passes over a waiting session that cannot be woken', () => {
    expect(decide(cron, [session('s1', { wait: 'question', wakeable: false })])).toEqual({ kind: 'start' })
    expect(decide(cron, [session('s1', { wait: 'question', wakeable: false }), session('s2', { wait: 'go' })])).toEqual({ kind: 'resume', sessionId: 's2', line: 'waiting' })
    expect(decide(wake('s-set'), [session('s1', { wait: 'question', wakeable: false }), session('s-set')])).toEqual({ kind: 'resume', sessionId: 's-set', line: 'wake' })
  })
})

describe('line c: nothing is open and the wake-up is due', () => {
  it('continues the session that set it', () => {
    expect(decide(wake('s-set'), [session('s-other'), session('s-set')])).toEqual({ kind: 'resume', sessionId: 's-set', line: 'wake' })
  })

  it('continues it also when it holds a review wait: only a working session and an answer wait come first', () => {
    expect(decide(wake('s-set'), [session('s-set', { wait: 'review' })])).toEqual({ kind: 'resume', sessionId: 's-set', line: 'wake' })
  })

  it('starts a new session when that session is gone, cannot be woken, or was never named', () => {
    expect(decide(wake('s-set'), [])).toEqual({ kind: 'start' })
    expect(decide(wake('s-set'), [session('s-other')])).toEqual({ kind: 'start' })
    expect(decide(wake('s-set'), [session('s-set', { wakeable: false })])).toEqual({ kind: 'start' })
    expect(decide(wake(null), [session('s1')])).toEqual({ kind: 'start' })
  })

  it('a firing that names the wake-up and repeating times is one run, in the wake-up\'s session', () => {
    // `times` says a time fired; the wake-up among them decides where the one run goes
    expect(decide({ times: true, wake: { bySession: 's-set' }, message: false }, [session('s-set'), session('s2')])).toEqual({ kind: 'resume', sessionId: 's-set', line: 'wake' })
  })
})

describe('line d: nothing is open and a repeating time or a message is due', () => {
  it('starts a new session for a repeating time, a run by hand and a message', () => {
    for (const fired of [cron, manual, message]) expect(decide(fired)).toEqual({ kind: 'start' })
  })

  it('starts a new session beside idle sessions of the task: an idle session is not open', () => {
    expect(decide(cron, [session('s1'), session('s2')])).toEqual({ kind: 'start' })
    expect(decide(message, [session('s1')])).toEqual({ kind: 'start' })
  })
})

describe('a channel message only goes to a session linked to the task\'s record: only that one has the bridge\'s tools', () => {
  it('a: a working session that is not linked does not get it: the bridge keeps the message and tries again', () => {
    expect(decide(message, [own('s-own', { working: true })])).toEqual({ kind: 'retry' })
    // also beside a linked session that is idle, or waits on an answer: nothing starts or continues beside the work
    expect(decide(message, [own('s-own', { working: true }), session('s-run')])).toEqual({ kind: 'retry' })
    expect(decide(message, [own('s-own', { working: true }), session('s-run', { wait: 'question' })])).toEqual({ kind: 'retry' })
  })

  it('a: of two working sessions the linked one gets it', () => {
    expect(decide(message, [own('s-own', { working: true }), session('s-run', { working: true })])).toEqual({ kind: 'deliver', sessionId: 's-run' })
    expect(decide(message, [own('s-own', { working: true }), session('s-run', { working: true, wakeable: false })])).toEqual({ kind: 'retry' })
  })

  it('b: a session that waits on an answer and is not linked is passed over: a new session starts, so the message is handled', () => {
    for (const wait of ['question', 'go']) expect(decide(message, [own('s-own', { wait })])).toEqual({ kind: 'start' })
    expect(decide(message, [own('s-own', { wait: 'question' }), session('s-run')])).toEqual({ kind: 'start' })
  })

  it('b: of two waiting sessions the linked one continues, whatever the order and the kind of wait', () => {
    expect(decide(message, [own('s-own', { wait: 'question' }), session('s-run', { wait: 'go' })])).toEqual({ kind: 'resume', sessionId: 's-run', line: 'waiting' })
    expect(decide(message, [session('s-run', { wait: 'question' }), own('s-own', { wait: 'question' })])).toEqual({ kind: 'resume', sessionId: 's-run', line: 'waiting' })
  })

  it('c: a message that comes with the wake-up does not continue the session that set it unless it is linked', () => {
    const both: Fired = { times: true, wake: { bySession: 's-set' }, message: true }
    expect(decide(both, [own('s-set')])).toEqual({ kind: 'start' })
    expect(decide(both, [session('s-set')])).toEqual({ kind: 'resume', sessionId: 's-set', line: 'wake' })
  })

  it('never names a session that is not linked for a message, whatever the task\'s sessions do', () => {
    const states: Array<Partial<FiringSession>> = [{}, { working: true }, { wait: 'question' }, { wait: 'go' }, { wait: 'review' }, { wakeable: false }, { working: true, wakeable: false }]
    for (const a of states) for (const b of states) for (const elsewhere of [false, true]) {
      const decision = decide(message, [own('s-own', a), session('s-run', b)], elsewhere)
      expect(decision.kind).not.toBe('skip')
      if ('sessionId' in decision) expect(decision.sessionId).toBe('s-run')
    }
  })

  it('times keep the order as it is: a session that is not linked is skipped for, continued and woken like any other', () => {
    expect(decide(cron, [own('s-own', { working: true })])).toEqual({ kind: 'skip' })
    expect(decide(cron, [own('s-own', { wait: 'question' })])).toEqual({ kind: 'resume', sessionId: 's-own', line: 'waiting' })
    expect(decide(wake('s-own'), [own('s-own')])).toEqual({ kind: 'resume', sessionId: 's-own', line: 'wake' })
    expect(decide(manual, [own('s-own', { wait: 'go' })])).toEqual({ kind: 'resume', sessionId: 's-own', line: 'waiting' })
  })
})
