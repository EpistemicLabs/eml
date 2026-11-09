import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnState } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-session-facts-'))

type Ledger = import('../src/session-ledger.js').SessionLedger
let SessionLedger: typeof import('../src/session-ledger.js').SessionLedger
let turnNotice: typeof import('../src/application/turn-notice.js').turnNotice
let sessionFacts: typeof import('../src/application/session-facts.js').sessionFacts
let withProject: typeof import('../src/application/session-facts.js').withProject

beforeAll(async () => {
  ({ SessionLedger } = await import('../src/session-ledger.js'))
  ;({ turnNotice } = await import('../src/application/turn-notice.js'))
  ;({ sessionFacts, withProject } = await import('../src/application/session-facts.js'))
})

const turnsOf = (states: Record<string, TurnState>) => ({ get: (id: string) => (states[id] ? { state: states[id], since: '' } : undefined) })
const projectName = (spaceId: string | null, projectId: string | null) => (projectId === 'p1' ? `Project one${spaceId ? ` in ${spaceId}` : ''}` : undefined)

// The ledger is one file in the test home: every test names its own sessions.
let run = 0

/** A main session and three workers it started; `id('w1')` is this test's name for a session. */
function batch(): { ledger: Ledger; id: (name: string) => string } {
  const prefix = `b${++run}-`
  const id = (name: string) => `${prefix}${name}`
  const ledger = new SessionLedger()
  ledger.recordSpawn(id('main'), null, 'p1', 'claude')
  for (const name of ['w1', 'w2', 'w3']) {
    ledger.expectParent(id(name), id('main'))
    ledger.recordSpawn(id(name), null, 'p1', 'claude', true)
  }
  return { ledger, id }
}

describe('turnNotice', () => {
  it('names a session by its title, else by the name its agent gave it', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('named', null, 'p1', 'claude')
    ledger.setAgentTitle('named', 'Agent name')
    expect(turnNotice({ ledger, turns: turnsOf({}) }, { sessionId: 'named', state: 'done', since: '' })).toEqual({ title: 'Agent name' })
    ledger.update('named', { title: 'User name' })
    expect(turnNotice({ ledger, turns: turnsOf({}) }, { sessionId: 'named', state: 'done', since: '' }).title).toBe('User name')
  })

  it('keeps a worker quiet while others of its batch work, and gives the batch size when the last one finishes', () => {
    const { ledger, id } = batch()
    expect(turnNotice({ ledger, turns: turnsOf({ [id('w2')]: 'working' }) }, { sessionId: id('w1'), state: 'done', since: '' }).silent).toBe(true)
    expect(turnNotice({ ledger, turns: turnsOf({}) }, { sessionId: id('w1'), state: 'done', since: '' }).batch).toBe(3)
    ledger.archive(id('w3'))
    expect(turnNotice({ ledger, turns: turnsOf({}) }, { sessionId: id('w1'), state: 'done', since: '' }).batch).toBe(2)
  })

  it('says nothing about a batch for a session without a parent or a turn that is not done', () => {
    const { ledger, id } = batch()
    expect(turnNotice({ ledger, turns: turnsOf({ [id('w2')]: 'working' }) }, { sessionId: id('main'), state: 'done', since: '' })).toEqual({ title: null })
    expect(turnNotice({ ledger, turns: turnsOf({ [id('w2')]: 'working' }) }, { sessionId: id('w1'), state: 'waiting', since: '' }).silent).toBeUndefined()
  })
})

describe('sessionFacts', () => {
  it('reads what a push needs from the ledger, the turn state and the project registry', () => {
    const { ledger, id } = batch()
    ledger.update(id('w1'), { title: 'Worker one' })
    ledger.setAttention(id('w1'), { kind: 'review', reason: 'PR ready' })
    ledger.setJobId(id('w1'), 'job-1')
    expect(sessionFacts({ ledger, turns: turnsOf({ [id('w1')]: 'done' }), projectName }, id('w1'))).toMatchObject({
      sessionId: id('w1'), jobId: 'job-1', title: 'Worker one', project: 'Project one', state: 'done',
      attention: { kind: 'review', reason: 'PR ready' }, batch: 3,
    })
  })

  it('marks a worker silent while its batch still works, and knows no unknown session', () => {
    const { ledger, id } = batch()
    expect(sessionFacts({ ledger, turns: turnsOf({ [id('w1')]: 'done', [id('w2')]: 'working' }), projectName }, id('w1'))).toMatchObject({ silent: true })
    expect(sessionFacts({ ledger, turns: turnsOf({}), projectName }, 'nobody')).toBeNull()
  })

  it('counts a session without a turn state as idle and without a known project as having none', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('unknown-project', null, 'other', 'claude')
    expect(sessionFacts({ ledger, turns: turnsOf({}), projectName }, 'unknown-project')).toMatchObject({ state: 'idle', project: null })
  })
})

describe('withProject', () => {
  const input = { kind: 'review' as const, title: 'Daily brief', body: 'Done', jobId: 'job-1', sessionId: 'job-run', spaceId: null }

  it('adds the project of the notice\'s session, in that session\'s space', () => {
    const ledger = new SessionLedger()
    ledger.recordSpawn('job-run', null, 'p1', 'claude', false, null, 'space-2')
    expect(withProject({ ledger, projectName }, input).project).toBe('Project one in space-2')
  })

  it('keeps a project the producer named, and leaves a notice without a session as it is', () => {
    const ledger = new SessionLedger()
    expect(withProject({ ledger, projectName }, { ...input, project: 'Named' }).project).toBe('Named')
    expect(withProject({ ledger, projectName }, { ...input, sessionId: null })).toEqual({ ...input, sessionId: null })
  })
})
